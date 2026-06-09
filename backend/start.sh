#!/bin/bash

# Скрипт для запуска backend сервера с загрузкой переменных окружения

# Переходим в директорию backend
cd "$(dirname "$0")"

# Проверяем наличие .env файла
if [ ! -f .env ]; then
    echo "⚠️  Файл .env не найден!"
    echo "📝 Создайте файл .env на основе .env.example:"
    echo "   cp .env.example .env"
    echo "   Затем отредактируйте .env и добавьте свои API ключи"
    echo ""
    echo "🚀 Запускаю сервер без API ключей (некоторые функции могут не работать)..."
    echo ""
fi

# Загружаем переменные окружения из .env (если файл существует)
if [ -f .env ]; then
    export $(cat .env | grep -v '^#' | xargs)
fi

# Для macOS с WeasyPrint
if [[ "$OSTYPE" == "darwin"* ]]; then
    export DYLD_LIBRARY_PATH=/opt/homebrew/lib
fi

# Запускаем сервер
echo "🚀 Запускаю backend сервер..."
python3 main.py

