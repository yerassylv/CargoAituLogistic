"""
Миграция для создания таблицы partnerships
"""
import sys
import os

_BACKEND_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _BACKEND_ROOT)
from database import engine, Base
from sqlalchemy import text

def migrate():
    """Создает таблицу partnerships если её нет"""
    try:
        from sqlalchemy import inspect
        inspector = inspect(engine)
        tables = inspector.get_table_names()
        if 'partnerships' not in tables:
            print('Создаем таблицу partnerships...')
            Base.metadata.create_all(bind=engine, tables=[Base.metadata.tables['partnerships']])
            print('✅ Таблица partnerships создана')
        else:
            print('✅ Таблица partnerships уже существует')
            columns = [col['name'] for col in inspector.get_columns('partnerships')]
            print(f'Колонки в таблице partnerships: {columns}')
    except Exception as e:
        print(f'❌ Ошибка при миграции: {e}')
        raise
if __name__ == '__main__':
    migrate()
