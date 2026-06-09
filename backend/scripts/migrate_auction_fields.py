"""
Миграция для добавления новых полей в таблицы requests и bids
"""
import os
import sys
from pathlib import Path

from sqlalchemy import create_engine, text, inspect
from sqlalchemy.orm import sessionmaker
from dotenv import load_dotenv

_BACKEND_ROOT = Path(__file__).resolve().parent.parent
load_dotenv(_BACKEND_ROOT / '.env')
DATABASE_URL = os.getenv('DATABASE_URL')
if not DATABASE_URL:
    print('Ошибка: DATABASE_URL не установлен в .env файле')
    sys.exit(1)
engine = create_engine(DATABASE_URL)
Session = sessionmaker(bind=engine)
session = Session()

def column_exists(table_name, column_name):
    """Проверяет, существует ли колонка в таблице"""
    inspector = inspect(engine)
    columns = [col['name'] for col in inspector.get_columns(table_name)]
    return column_name in columns

def add_column_if_not_exists(table_name, column_name, column_type, nullable=True, default=None):
    """Добавляет колонку, если она не существует"""
    if column_exists(table_name, column_name):
        print(f'  ✓ Колонка {table_name}.{column_name} уже существует')
        return False
    try:
        default_clause = f' DEFAULT {default}' if default is not None else ''
        nullable_clause = 'NULL' if nullable else 'NOT NULL'
        query = f'ALTER TABLE {table_name} ADD COLUMN {column_name} {column_type} {nullable_clause}{default_clause}'
        session.execute(text(query))
        session.commit()
        print(f'  ✓ Добавлена колонка {table_name}.{column_name}')
        return True
    except Exception as e:
        print(f'  ✗ Ошибка при добавлении колонки {table_name}.{column_name}: {e}')
        session.rollback()
        return False

def create_index_if_not_exists(table_name, column_name):
    """Создает индекс, если он не существует"""
    index_name = f'idx_{table_name}_{column_name}'
    try:
        query = f'CREATE INDEX IF NOT EXISTS {index_name} ON {table_name}({column_name})'
        session.execute(text(query))
        session.commit()
        print(f'  ✓ Создан индекс {index_name}')
    except Exception as e:
        print(f'  ✗ Ошибка при создании индекса {index_name}: {e}')
        session.rollback()
print('🚀 Начинаем миграцию базы данных...')
print()
print('📋 Обновление таблицы requests:')
add_column_if_not_exists('requests', 'min_price', 'FLOAT', nullable=True)
add_column_if_not_exists('requests', 'auction_type', 'VARCHAR', nullable=True, default="'OPEN'")
add_column_if_not_exists('requests', 'bidding_started_at', 'TIMESTAMP', nullable=True)
add_column_if_not_exists('requests', 'bidding_ends_at', 'TIMESTAMP', nullable=True)
add_column_if_not_exists('requests', 'revision', 'INTEGER', nullable=False, default=0)
add_column_if_not_exists('requests', 'completion_requested_at', 'TIMESTAMP', nullable=True)
add_column_if_not_exists('requests', 'completion_confirmed_at', 'TIMESTAMP', nullable=True)
create_index_if_not_exists('requests', 'bidding_started_at')
create_index_if_not_exists('requests', 'bidding_ends_at')
print()
print('📋 Обновление таблицы bids:')
add_column_if_not_exists('bids', 'is_active', 'BOOLEAN', nullable=False, default='TRUE')
add_column_if_not_exists('bids', 'revision', 'INTEGER', nullable=False, default=0)
create_index_if_not_exists('bids', 'is_active')
print()
print('🔄 Обновление существующих данных:')
try:
    session.execute(text('UPDATE bids SET is_active = TRUE WHERE is_active IS NULL'))
    session.commit()
    print('  ✓ Обновлены существующие ставки (is_active = TRUE)')
except Exception as e:
    print(f'  ✗ Ошибка при обновлении ставок: {e}')
    session.rollback()
try:
    session.execute(text('UPDATE requests SET revision = 0 WHERE revision IS NULL'))
    session.execute(text('UPDATE bids SET revision = 0 WHERE revision IS NULL'))
    session.commit()
    print('  ✓ Обновлены revision для существующих записей')
except Exception as e:
    print(f'  ✗ Ошибка при обновлении revision: {e}')
    session.rollback()
print()
print('✅ Миграция завершена!')
session.close()
