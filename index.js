const { exec } = require('child_process');
const { promisify } = require('util');
const schedule = require('node-schedule');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');
const archiver = require('archiver');

const execAsync = promisify(exec);

// CONFIG
const DB_USER = 'SKYNEST';
const DB_PASSWORD = 'SKYNEST11';
const DISCORD_TEXT_WEBHOOK_URL = 'https://discord.com/api/webhooks/1380164234935013436/pldPJiMIjj_ItP4lqjs2wPXoZcsB2xhCqnqHhqOFxrY02kjPEcpxi8pti5eiPW3gyodf'; // Webhook teks
const DISCORD_FILE_WEBHOOK_URL = 'https://discord.com/api/webhooks/1380031216018788402/KSRbKpI4MfyBZoxZHtd3anH119i6_G1qJzmaTBkKdWgfLPGI729m7hy6FvDs8Hj8i9mU'; // Webhook file
const backupBaseDir = path.join(__dirname, 'database');
const excludedTables = ['performance_schema', 'information_schema', 'phpmyadmin', 'mysql', 'Database'];
const FILE_SIZE_LIMIT_MB = 7; 

async function getCurrentDate() {
    return new Date().toISOString().split('T')[0];
}

async function ensureDirectoryExists(directory) {
    if (!fs.existsSync(directory)) {
        fs.mkdirSync(directory, { recursive: true });
    }
}

async function backupDatabase(databaseName) {
    const date = await getCurrentDate();
    const backupDir = path.join(backupBaseDir, databaseName);
    const backupFile = path.join(backupDir, `${databaseName}-${date}.sql`);

    try {
        await ensureDirectoryExists(backupDir);
        const excludedTablesString = excludedTables.map(table => `--ignore-table=${databaseName}.${table}`).join(' ');
        const command = `/usr/bin/mysqldump -u ${DB_USER} -p'${DB_PASSWORD}' --opt ${databaseName} ${excludedTablesString} > ${backupFile}`;

        await execAsync(command);
        return { databaseName, success: true, backupFile };
    } catch (error) {
        return { databaseName, success: false, error: error.message };
    }
}

async function createZip(sqlFilePath) {
    const zipFilePath = sqlFilePath.replace('.sql', '.zip');
    
    return new Promise((resolve, reject) => {
        const output = fs.createWriteStream(zipFilePath);
        const archive = archiver('zip', { zlib: { level: 9 } });

        output.on('close', () => resolve(zipFilePath));
        archive.on('error', reject);

        archive.pipe(output);
        archive.file(sqlFilePath, { name: path.basename(sqlFilePath) });
        archive.finalize();
    });
}

async function sendBackupFileToDiscord(filePath, databaseName) {
    if (!filePath || !fs.existsSync(filePath)) {
        console.error(`❌ File tidak ditemukan: ${filePath}`);
        return null;
    }

    const fileSizeMB = fs.statSync(filePath).size / (1024 * 1024);
    const isZip = filePath.endsWith('.zip');
    const fileName = path.basename(filePath);
    const fileLabel = `⬇️ **${databaseName.toUpperCase()}**`;

    try {

        const embedPayload = {
            content: null,
            embeds: [{
                title: fileLabel,
                color: 0x3498db, 
                description: `📄 File: **${fileName}**`,
                timestamp: new Date().toISOString()
            }]
        };

        const embedResponse = await axios.post(DISCORD_FILE_WEBHOOK_URL, embedPayload);
        console.log(`📩 Embed terkirim untuk ${fileName}`);

        if (embedResponse.status !== 204 && embedResponse.status !== 200) {
            throw new Error(`Gagal mengirim embed: ${embedResponse.statusText}`);
        }

        await delay(1500);

        const form = new FormData();
        form.append('file', fs.createReadStream(filePath));

        const fileResponse = await axios.post(DISCORD_FILE_WEBHOOK_URL, form, {
            headers: { ...form.getHeaders() },
        });

        if (fileResponse.status === 200) {
            console.log(`✅ File ${fileName} berhasil dikirim ke Discord`);
            return isZip ? 'zip' : 'sql';
        } else {
            throw new Error(`Gagal mengirim file: ${fileResponse.statusText}`);
        }
    } catch (error) {
        console.error(`❌ Error saat mengirim backup ${fileName}:`, error.response?.data || error.message);
        return null;
    }
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function backupDatabases() {
    try {
        const { stdout } = await execAsync(`/usr/bin/mysql -u ${DB_USER} -p'${DB_PASSWORD}' -e "SHOW DATABASES;"`);
        const databases = stdout.split('\n').map(db => db.trim()).filter(db => db && !excludedTables.includes(db));

        let successfulBackups = 0;
        let zipCount = 0;
        let sqlCount = 0;

        for (const db of databases) {
            const result = await backupDatabase(db);
            if (result.success) {
                successfulBackups++;
                const fileSizeMB = fs.statSync(result.backupFile).size / (1024 * 1024);

                if (fileSizeMB > FILE_SIZE_LIMIT_MB) {
                    console.log(`${result.backupFile} melebihi ${FILE_SIZE_LIMIT_MB}MB, membuat ZIP...`);
                    const zipFile = await createZip(result.backupFile);
                    const sentType = await sendBackupFileToDiscord(zipFile, db);
                    if (sentType === 'zip') zipCount++;
                } else {
                    const sentType = await sendBackupFileToDiscord(result.backupFile, db);
                    if (sentType === 'sql') sqlCount++;
                }
            }
        }

        await sendBackupSummaryToDiscord(databases.length, successfulBackups, zipCount, sqlCount);
    } catch (error) {
        console.error('Error fetching databases:', error.message);
        await sendBackupSummaryToDiscord(0, 0, 0, 0, `Error fetching databases: ${error.message}`);
    }
}

async function sendBackupSummaryToDiscord(totalDatabases, successfulBackups, zipCount, sqlCount, errorMessage = null) {
    const date = await getCurrentDate();
    
    const backupSummary = [
        `📅 **Tanggal**: ${date}`,
        `✅ **Backup Status**: ${errorMessage || 'Backup database telah berhasil dilakukan!'}`,
        `📊 **Total Database ter-backup**: ${successfulBackups}/${totalDatabases}`,
        `📦 **Total ZIP files created**: ${zipCount}`,
        `📄 **Total SQL files created**: ${sqlCount}`
    ].join('\n');

    const embed = {
        embeds: [{
            title: '📂 Database Backup',
            color: errorMessage ? 0xff0000 : 0x00ff00, 
            description: backupSummary, 
            timestamp: new Date().toISOString()
        }]
    };

    try {
        await axios.post(DISCORD_TEXT_WEBHOOK_URL, embed);
        console.log('Backup summary sent to Discord');
    } catch (error) {
        console.error('Error sending backup summary:', error.message);
    }
}


schedule.scheduleJob('0 */3 * * *', backupDatabases);
backupDatabases();
