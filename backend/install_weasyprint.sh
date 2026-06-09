#!/bin/bash
# Скрипт для установки WeasyPrint и зависимостей на macOS
# Использование: ./install_weasyprint.sh

set -e  # Остановка при ошибке

echo "🚀 Установка WeasyPrint для macOS"
echo "=================================="
echo ""

# Цвета для вывода
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Проверка наличия Homebrew
if ! command -v brew &> /dev/null; then
    echo -e "${RED}❌ Homebrew не установлен!${NC}"
    echo "Установите Homebrew:"
    echo '  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'
    exit 1
fi

echo -e "${GREEN}✅ Homebrew найден${NC}"
echo ""

# Проверка и установка системных зависимостей
echo "📦 Проверка системных зависимостей..."

DEPENDENCIES=("cairo" "pango" "gdk-pixbuf" "gobject-introspection")
MISSING_DEPS=()

for dep in "${DEPENDENCIES[@]}"; do
    if brew list "$dep" &> /dev/null; then
        echo -e "${GREEN}✅ $dep уже установлен${NC}"
    else
        echo -e "${YELLOW}⚠️  $dep не найден${NC}"
        MISSING_DEPS+=("$dep")
    fi
done

if [ ${#MISSING_DEPS[@]} -gt 0 ]; then
    echo ""
    echo "📥 Установка недостающих зависимостей..."
    brew install "${MISSING_DEPS[@]}"
    echo -e "${GREEN}✅ Системные зависимости установлены${NC}"
else
    echo -e "${GREEN}✅ Все системные зависимости уже установлены${NC}"
fi

echo ""

# Проверка Python
if ! command -v python3 &> /dev/null; then
    echo -e "${RED}❌ Python3 не найден!${NC}"
    exit 1
fi

PYTHON_VERSION=$(python3 --version)
echo -e "${GREEN}✅ Python найден: $PYTHON_VERSION${NC}"
echo ""

# Установка WeasyPrint
echo "📦 Установка WeasyPrint..."

# Определяем путь к библиотекам Homebrew
if [ -d "/opt/homebrew/lib" ]; then
    HOMEBREW_LIB="/opt/homebrew/lib"
elif [ -d "/usr/local/lib" ]; then
    HOMEBREW_LIB="/usr/local/lib"
else
    HOMEBREW_LIB="/opt/homebrew/lib"
fi

# Устанавливаем переменную окружения для текущей сессии
export DYLD_LIBRARY_PATH="$HOMEBREW_LIB"

# Пробуем установить с разными опциями
if python3 -m pip install --break-system-packages weasyprint &> /dev/null; then
    echo -e "${GREEN}✅ WeasyPrint установлен (с --break-system-packages)${NC}"
elif python3 -m pip install --user weasyprint &> /dev/null; then
    echo -e "${GREEN}✅ WeasyPrint установлен (в --user директорию)${NC}"
elif python3 -m pip install weasyprint &> /dev/null; then
    echo -e "${GREEN}✅ WeasyPrint установлен${NC}"
else
    echo -e "${YELLOW}⚠️  Попытка установки с --break-system-packages...${NC}"
    python3 -m pip install --break-system-packages weasyprint
fi

echo ""

# Проверка установки
echo "🧪 Проверка установки..."
if DYLD_LIBRARY_PATH="$HOMEBREW_LIB" python3 -c "from weasyprint import HTML; print('OK')" 2>/dev/null; then
    echo -e "${GREEN}✅ WeasyPrint работает корректно!${NC}"
else
    echo -e "${RED}❌ Ошибка при проверке WeasyPrint${NC}"
    echo "Попробуйте запустить вручную:"
    echo "  DYLD_LIBRARY_PATH=$HOMEBREW_LIB python3 -c 'from weasyprint import HTML; print(\"OK\")'"
    exit 1
fi

echo ""
echo "=================================="
echo -e "${GREEN}🎉 Установка завершена успешно!${NC}"
echo ""
echo "📝 Для запуска backend сервера используйте:"
echo ""
echo "  export DYLD_LIBRARY_PATH=$HOMEBREW_LIB"
echo "  python3 main.py"
echo ""
echo "Или в одной строке:"
echo ""
echo "  DYLD_LIBRARY_PATH=$HOMEBREW_LIB python3 main.py"
echo ""
echo "💡 Для постоянной настройки добавьте в ~/.zshrc или ~/.bash_profile:"
echo "   export DYLD_LIBRARY_PATH=$HOMEBREW_LIB"
echo ""

