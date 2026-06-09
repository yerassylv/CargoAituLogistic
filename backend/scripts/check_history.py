"""
Скрипт для проверки и очистки некорректных записей истории заявок
"""
import sqlite3
from pathlib import Path
db_path = Path(__file__).resolve().parent.parent / 'cargoainur.db'
if not db_path.exists():
    print(f'❌ База данных не найдена: {db_path}')
    exit(1)
conn = sqlite3.connect(str(db_path))
cursor = conn.cursor()
print('🔍 Проверка истории заявок...\n')
cursor.execute('SELECT id, request_id, event_type, description, created_at FROM request_history ORDER BY created_at DESC')
all_history = cursor.fetchall()
print(f'Всего записей в истории: {len(all_history)}\n')
cursor.execute('SELECT id FROM requests')
existing_request_ids = {row[0] for row in cursor.fetchall()}
print(f'Существующих заявок: {len(existing_request_ids)}')
print(f'ID заявок: {sorted(existing_request_ids)}\n')
wrong_history = []
for h_id, request_id, event_type, description, created_at in all_history:
    if request_id not in existing_request_ids:
        wrong_history.append((h_id, request_id, event_type, description, created_at))
if wrong_history:
    print(f'⚠️  Найдено {len(wrong_history)} записей с неправильным request_id:\n')
    for h_id, request_id, event_type, description, created_at in wrong_history:
        print(f'  - ID записи: {h_id}')
        print(f'    request_id: {request_id} (заявка не существует!)')
        print(f'    Событие: {event_type}')
        print(f'    Дата: {created_at}')
        print()
    print('\n❓ Удалить эти записи? (y/n): ', end='')
    answer = input().strip().lower()
    if answer == 'y':
        for h_id, request_id, _, _, _ in wrong_history:
            cursor.execute('DELETE FROM request_history WHERE id = ?', (h_id,))
        conn.commit()
        print(f'✅ Удалено {len(wrong_history)} записей')
    else:
        print('❌ Удаление отменено')
else:
    print('✅ Все записи истории корректны!')
print('\n📊 Статистика по заявкам:\n')
for request_id in sorted(existing_request_ids):
    cursor.execute('SELECT COUNT(*) FROM request_history WHERE request_id = ?', (request_id,))
    count = cursor.fetchone()[0]
    cursor.execute('SELECT title FROM requests WHERE id = ?', (request_id,))
    title = cursor.fetchone()
    title_str = title[0] if title else 'Без названия'
    print(f'  Заявка #{request_id} ({title_str[:50]}): {count} записей в истории')
conn.close()
print('\n✅ Проверка завершена')
