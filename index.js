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
const DISCORD_TEXT_WEBHOOK_URL = 'https://discord.com/api/webhooks/1375686173552545872/tX31Nq-Yx85GZNKIURRZ3pb12pMi7bWj86RsR8_fKJtbUoWJVnuB5Wp50obLPojIFj5X'; // Webhook teks
const DISCORD_FILE_WEBHOOK_URL = 'https://discord.com/api/webhooks/1375686718229057616/KWJ9ZbirU5RRe_XsW1OE2vOveSi2noyOdt4Ij1jFCsdKmkZNVjgVSo0aCisEWNMnPZ1d'; // Webhook file
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
    const successRate = totalDatabases > 0 ? ((successfulBackups / totalDatabases) * 100).toFixed(1) : '0.0';

    const embed = {
        username: 'SkyNest Backup System',
        avatar_url: 'https://cdn.discordapp.com/attachments/1375511374444367872/1380909930776629289/thumbnail.jpg?ex=68459817&is=68444697&hm=eeab047ec8754ac79801c6a67727f6ee2c7a1519e80ee1f3fa9e057d820a705c&',
        embeds: [
            {
                title: errorMessage ? '🛑 Backup Gagal!' : '📦 Backup Database Selesai',
                color: errorMessage ? 0xff3c3c : 0x4cd137,
                thumbnail: {
                    url: errorMessage
                        ? 'https://media.discordapp.net/attachments/1378368863510593699/1378373152052350996/683b0b8380b1c1de888fe39a.gif?ex=68459808&is=68444688&hm=124848fcb898af75a9367a20fcaab5f7de7cd0e74095487c9292e73db4a89512&width=585&height=75&'
                        : 'https://media.discordapp.net/attachments/1378368863510593699/1378373152052350996/683b0b8380b1c1de888fe39a.gif?ex=68459808&is=68444688&hm=124848fcb898af75a9367a20fcaab5f7de7cd0e74095487c9292e73db4a89512&width=585&height=75&'
                },
                fields: [
                    {
                        name: '📅 Tanggal',
                        value: `\`${date}\``,
                        inline: true
                    },
                    {
                        name: '📁 Total Database',
                        value: `\`${totalDatabases}\``,
                        inline: true
                    },
                    {
                        name: '✅ Sukses Dibackup',
                        value: `\`${successfulBackups}\` (${successRate}%)`,
                        inline: true
                    },
                    {
                        name: '📦 ZIP Files',
                        value: `\`${zipCount}\``,
                        inline: true
                    },
                    {
                        name: '📄 SQL Files',
                        value: `\`${sqlCount}\``,
                        inline: true
                    }
                ],
                description: errorMessage
                    ? `**❗ Terjadi kesalahan saat proses backup:**\n\`${errorMessage}\``
                    : 'Backup telah berhasil dilakukan dan file telah dikirim ke Discord Webhook.',
                footer: {
                    text: 'SkyNest • Automated Backup System',
                    icon_url: 'https://cdn.discordapp.com/attachments/1375511374444367872/1380909930776629289/thumbnail.jpg?ex=68459817&is=68444697&hm=eeab047ec8754ac79801c6a67727f6ee2c7a1519e80ee1f3fa9e057d820a705c&'
                },
                timestamp: new Date().toISOString()
            }
        ]
    };

    try {
        await axios.post(DISCORD_TEXT_WEBHOOK_URL, embed);
        console.log('✅ Summary backup premium berhasil dikirim.');
    } catch (error) {
        console.error('❌ Gagal kirim summary:', error.message);
    }
}

schedule.scheduleJob('0 */3 * * *', backupDatabases);
backupDatabases();
