"""Проверка заявок в базе"""
import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from database import SessionLocal, Request
from sqlalchemy.orm import joinedload
db = SessionLocal()
try:
    requests = db.query(Request).options(joinedload(Request.customer), joinedload(Request.selected_carrier)).order_by(Request.id.desc()).limit(10).all()
    print(f'Найдено заявок: {len(requests)}\n')
    for req in requests:
        print(f'ID: {req.id}')
        print(f'  Статус: {req.status}')
        print(f"  Заказчик: {(req.customer.full_name if req.customer else 'N/A')}")
        print(f"  Перевозчик: {(req.selected_carrier.full_name if req.selected_carrier else 'N/A')}")
        print(f"  Акт создан: {('Да' if req.act_path else 'Нет')}")
        print(f"  Акт подписан: {('Да' if req.signed_act_path else 'Нет')}")
        print(f"  Счет-фактура: {('Да' if req.invoice_path else 'Нет')}")
        print()
finally:
    db.close()
