"""
Скрипт для добавления колонки bin в таблицу users
"""
import os
import sys
from pathlib import Path

from sqlalchemy import create_engine, text
from dotenv import load_dotenv

_BACKEND_ROOT = Path(__file__).resolve().parent.parent
load_dotenv(_BACKEND_ROOT / '.env')
DATABASE_URL = os.getenv('DATABASE_URL')
if not DATABASE_URL:
    print('❌ Ошибка: DATABASE_URL не установлен в .env файле')
    sys.exit(1)
if not DATABASE_URL.startswith('postgresql'):
    print('❌ Ошибка: Поддерживается только PostgreSQL')
    sys.exit(1)
try:
    engine = create_engine(DATABASE_URL)
    with engine.connect() as conn:
        check_query = text("\n            SELECT column_name \n            FROM information_schema.columns \n            WHERE table_name = 'users' AND column_name = 'bin'\n        ")
        result = conn.execute(check_query)
        column_exists = result.fetchone() is not None
        if column_exists:
            print("✅ Колонка 'bin' уже существует в таблице 'users'")
        else:
            print("🔄 Добавляю колонку 'bin' в таблицу 'users'...")
            alter_query = text('\n                ALTER TABLE users \n                ADD COLUMN bin VARCHAR NULL\n            ')
            conn.execute(alter_query)
            conn.commit()
            print("🔄 Создаю индекс для колонки 'bin'...")
            index_query = text('\n                CREATE INDEX IF NOT EXISTS ix_users_bin ON users(bin)\n            ')
            conn.execute(index_query)
            conn.commit()
            print("✅ Колонка 'bin' успешно добавлена в таблицу 'users'")
    print('✅ Миграция завершена успешно!')
except Exception as e:
    print(f'❌ Ошибка при выполнении миграции: {e}')
    sys.exit(1)
