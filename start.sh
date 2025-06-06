#!/bin/bash

# Define the name of your Node.js script
SCRIPT_NAME="index.js"

# Define a function to start the backup process
start_backup() {
    pm2 start $SCRIPT_NAME
    echo "Backup process started."
}

# Define a function to stop the backup process
stop_backup() {
    pm2 stop $SCRIPT_NAME
    echo "Backup process stopped."
}

# Define a function to restart the backup process
restart_backup() {
    pm2 restart $SCRIPT_NAME
    echo "Backup process restarted."
}

# Menu function
show_menu() {
    echo "===================================="
    echo "  Database Backup Management Menu   "
    echo "===================================="
    echo "1. Start Backup"
    echo "2. Stop Backup"
    echo "3. Restart Backup"
    echo "4. Exit"
    echo "===================================="
    echo -n "Please choose an option [1-4]: "
    read choice
    case $choice in
        1) start_backup ;;
        2) stop_backup ;;
        3) restart_backup ;;
        4) exit 0 ;;
        *) echo "Invalid option!" ;;
    esac
}

# Infinite loop to show the menu until the user exits
while true; do
    show_menu
done
