DB_USER="username"
DB_PASSWORD="mypassword"
DB_NAME="tournament_db"
CONTAINER_DB="mk_reset_online-db-1"
BACKUP_DIR="./backups"


save() {
    mkdir -p $BACKUP_DIR
    TIMESTAMP=$(date +"%Y-%m-%d_%H-%M-%S")
    FILENAME="$BACKUP_DIR/backup_$TIMESTAMP.sql.gz"

    echo "💾 Sauvegarde en cours..."
    
    export PGPASSWORD=$DB_PASSWORD
    
    docker exec -t $CONTAINER_DB pg_dump -U $DB_USER --clean $DB_NAME | gzip > $FILENAME

    if [ $? -eq 0 ]; then
        echo "✅ Succès ! Fichier créé : $FILENAME"
        find $BACKUP_DIR -type f -name "*.sql.gz" -mtime +30 -delete
    else
        echo "❌ Erreur lors de la sauvegarde."
        rm -f $FILENAME
    fi
}

restore() {
    SEARCH_TERM=$1

    if [ -z "$SEARCH_TERM" ]; then
        echo "❌ Erreur : Spécifiez une date (ex: ./backup restore 2025)."
        exit 1
    fi

    MATCHING_FILE=$(find $BACKUP_DIR -name "*$SEARCH_TERM*.sql.gz" | sort | tail -n 1)

    if [ -z "$MATCHING_FILE" ]; then
        echo "❌ Aucun fichier trouvé pour : '$SEARCH_TERM'"
        exit 1
    fi

    echo "⚠️  ATTENTION : Restauration de $MATCHING_FILE"
    echo "⚠️  La base de données actuelle sera ENTIÈREMENT EFFACÉE."
    read -p "Confirmer ? (oui/non) : " CONFIRM

    if [[ "$CONFIRM" != "oui" ]]; then
        echo "Annulé."
        exit 0
    fi

    echo "🛑 Arrêt du site..."
    docker-compose stop frontend backend

    export PGPASSWORD=$DB_PASSWORD

    echo "🧹 Nettoyage complet de la base de données..."

    docker exec -i $CONTAINER_DB psql -U $DB_USER -d $DB_NAME -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;" > /dev/null 2>&1

    echo "🔄 Réinjection des données..."
    zcat $MATCHING_FILE | docker exec -i $CONTAINER_DB psql -U $DB_USER -d $DB_NAME > /dev/null 2>&1

    if [ $? -eq 0 ]; then
        echo "✅ Restauration réussie !"
    else
        echo "❌ Erreur pendant la restauration."
    fi

    echo "▶️  Redémarrage du site..."
    docker-compose start frontend backend
}


case "$1" in
    save)
        save
        ;;
    restore)
        restore "$2"
        ;;
    *)
        echo "Usage : ./backup [save | restore <date>]"
        exit 1
        ;;
esac
