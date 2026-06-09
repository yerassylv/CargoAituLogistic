"""
Скрипт для генерации счет-фактуры через терминал
"""
import sys
import os
_BACKEND_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _BACKEND_ROOT)
from database import SessionLocal, Request, User
from sqlalchemy.orm import joinedload
from datetime import datetime
from jinja2 import Environment, FileSystemLoader
from pathlib import Path
import weasyprint

def get_jinja_env():
    """Получить окружение Jinja2 с кешированием"""
    templates_dir = Path(__file__).resolve().parent.parent / 'templates'
    env = Environment(loader=FileSystemLoader(str(templates_dir)), auto_reload=False, enable_async=False)
    return env

def number_to_words(num, currency='KZT'):
    """Преобразует число в слова (поддержка миллионов) с учетом валюты"""
    currency_words = {'KZT': {'zero': 'ноль тенге', 'one': 'тенге', 'two_four': 'тенге', 'many': 'тенге', 'fraction_one': 'тиын', 'fraction_two_four': 'тиына', 'fraction_many': 'тиынов'}, 'RUB': {'zero': 'ноль рублей', 'one': 'рубль', 'two_four': 'рубля', 'many': 'рублей', 'fraction_one': 'копейка', 'fraction_two_four': 'копейки', 'fraction_many': 'копеек'}, 'USD': {'zero': 'ноль долларов', 'one': 'доллар', 'two_four': 'доллара', 'many': 'долларов', 'fraction_one': 'цент', 'fraction_two_four': 'цента', 'fraction_many': 'центов'}, 'EUR': {'zero': 'ноль евро', 'one': 'евро', 'two_four': 'евро', 'many': 'евро', 'fraction_one': 'цент', 'fraction_two_four': 'цента', 'fraction_many': 'центов'}}
    curr = currency_words.get(currency, currency_words['KZT'])
    if num == 0:
        return curr['zero']
    ones = ['', 'один', 'два', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять']
    ones_f = ['', 'одна', 'две', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять']
    tens = ['', 'десять', 'двадцать', 'тридцать', 'сорок', 'пятьдесят', 'шестьдесят', 'семьдесят', 'восемьдесят', 'девяносто']
    teens = ['десять', 'одиннадцать', 'двенадцать', 'тринадцать', 'четырнадцать', 'пятнадцать', 'шестнадцать', 'семнадцать', 'восемнадцать', 'девятнадцать']
    hundreds = ['', 'сто', 'двести', 'триста', 'четыреста', 'пятьсот', 'шестьсот', 'семьсот', 'восемьсот', 'девятьсот']
    amount = int(num)
    fraction = int(round((num - amount) * 100))

    def convert_three_digits(n, feminine=False):
        """Конвертирует трехзначное число"""
        if n == 0:
            return ''
        result = []
        if n >= 100:
            result.append(hundreds[n // 100])
            n %= 100
        if n >= 20:
            result.append(tens[n // 10])
            n %= 10
        elif n >= 10:
            result.append(teens[n - 10])
            n = 0
        if n > 0:
            result.append(ones_f[n] if feminine else ones[n])
        return ' '.join(result)
    parts = []
    millions = amount // 1000000
    if millions > 0:
        parts.append(convert_three_digits(millions))
        if millions % 10 == 1 and millions % 100 != 11:
            parts.append('миллион')
        elif millions % 10 in [2, 3, 4] and millions % 100 not in [12, 13, 14]:
            parts.append('миллиона')
        else:
            parts.append('миллионов')
        amount %= 1000000
    thousands = amount // 1000
    if thousands > 0:
        parts.append(convert_three_digits(thousands, feminine=True))
        if thousands % 10 == 1 and thousands % 100 != 11:
            parts.append('тысяча')
        elif thousands % 10 in [2, 3, 4] and thousands % 100 not in [12, 13, 14]:
            parts.append('тысячи')
        else:
            parts.append('тысяч')
        amount %= 1000
    if amount > 0:
        parts.append(convert_three_digits(amount))
    if not parts:
        return curr['zero']
    last_digit = int(num) % 10
    last_two = int(num) % 100
    if last_digit == 1 and last_two != 11:
        currency_word = curr['one']
    elif last_digit in [2, 3, 4] and last_two not in [12, 13, 14]:
        currency_word = curr['two_four']
    else:
        currency_word = curr['many']
    result = ' '.join(parts) + ' ' + currency_word
    if fraction > 0:
        fraction_last = fraction % 10
        fraction_last_two = fraction % 100
        if fraction_last == 1 and fraction_last_two != 11:
            fraction_word = curr['fraction_one']
        elif fraction_last in [2, 3, 4] and fraction_last_two not in [12, 13, 14]:
            fraction_word = curr['fraction_two_four']
        else:
            fraction_word = curr['fraction_many']
        result += ' ' + str(fraction) + ' ' + fraction_word
    return result.capitalize()

def generate_invoice_for_request(request_id: int=None):
    """Генерирует счет-фактуру для заявки"""
    db = SessionLocal()
    try:
        if request_id:
            request = db.query(Request).options(joinedload(Request.customer), joinedload(Request.selected_carrier), joinedload(Request.assigned_driver), joinedload(Request.assigned_vehicle), joinedload(Request.selected_bid)).filter(Request.id == request_id).first()
            if not request:
                print(f'❌ Заявка с ID {request_id} не найдена')
                return
        else:
            request = db.query(Request).options(joinedload(Request.customer), joinedload(Request.selected_carrier), joinedload(Request.assigned_driver), joinedload(Request.assigned_vehicle), joinedload(Request.selected_bid)).filter(Request.signed_act_path.isnot(None)).order_by(Request.id.desc()).first()
            if not request:
                print('❌ Не найдено заявок с подписанным актом')
                return
        print(f'✅ Найдена заявка ID: {request.id}, статус: {request.status}')
        customer = request.customer
        carrier = request.selected_carrier
        driver = request.assigned_driver
        vehicle = request.assigned_vehicle
        selected_bid = request.selected_bid
        if not customer or not carrier:
            print('❌ Не удалось загрузить данные заказчика или перевозчика')
            return
        if request.invoice_path:
            print(f'⚠️  Счет-фактура уже создана: {request.invoice_path}')
            print('   Перегенерируем...')
        invoice_number = f"СФ-{request.id}-{datetime.utcnow().strftime('%Y%m%d')}"
        invoice_date = datetime.utcnow().strftime('%d.%m.%Y')
        request_date = request.created_at.strftime('%d.%m.%Y') if request.created_at else invoice_date
        loading_date = request.loading_date.strftime('%d.%m.%Y') if request.loading_date else ''
        loading_time = request.loading_date.strftime('%H:%M') if request.loading_date else ''
        delivery_date = request.delivery_date.strftime('%d.%m.%Y') if request.delivery_date else ''
        delivery_time = request.delivery_date.strftime('%H:%M') if request.delivery_date else ''
        price = selected_bid.price if selected_bid else request.max_price or 0
        currency = getattr(carrier, 'payment_currency', None) or 'KZT'
        currency_symbol = '₸' if currency == 'KZT' else '₽' if currency == 'RUB' else currency
        jinja_env = get_jinja_env()
        template = jinja_env.get_template('invoice.html')
        total_amount = price
        total_amount_words = number_to_words(total_amount, currency)
        html_content = template.render(invoice_number=invoice_number, invoice_date=invoice_date, bank_name=getattr(carrier, 'bank_name', None) or 'Банк получателя', bank_bik=getattr(carrier, 'bank_bik', None) or '-', bank_corr_account=getattr(carrier, 'bank_corr_account', None) or '-', supplier_inn=carrier.iin or '-', supplier_kpp=getattr(carrier, 'kpp', None) or '-', supplier_account=getattr(carrier, 'bank_account', None) or '-', supplier_company=getattr(carrier, 'recipient_name', None) or carrier.company_name or carrier.full_name, supplier_address=getattr(carrier, 'address', None) or '-', customer_company=customer.company_name or customer.full_name, customer_inn=customer.iin or '-', customer_kpp=getattr(customer, 'kpp', None) or '-', customer_address=getattr(customer, 'address', None) or '-', from_city=request.from_city, to_city=request.to_city, price=f'{price:,.0f}'.replace(',', ' ') + f' {currency_symbol}', vat_amount=None, total_amount=f'{total_amount:,.0f}'.replace(',', ' ') + f' {currency_symbol}', total_amount_words=total_amount_words, director_name=getattr(carrier, 'director_name', None) or '', accountant_name=getattr(carrier, 'accountant_name', None) or '', currency=currency_symbol)
        invoices_dir = Path(__file__).parent / 'invoices'
        invoices_dir.mkdir(exist_ok=True)
        pdf_path = invoices_dir / f"invoice_{request.id}_{datetime.utcnow().strftime('%Y%m%d_%H%M%S')}.pdf"
        weasyprint.HTML(string=html_content).write_pdf(str(pdf_path))
        request.invoice_path = str(pdf_path.relative_to(Path(__file__).parent))
        request.invoice_number = invoice_number
        request.invoice_created_at = datetime.utcnow()
        db.commit()
        print(f'✅ Счет-фактура успешно создана!')
        print(f'   Номер: {invoice_number}')
        print(f'   Путь: {pdf_path}')
        print(f'   Заявка ID: {request.id}')
    except Exception as e:
        print(f'❌ Ошибка при генерации счет-фактуры: {str(e)}')
        import traceback
        traceback.print_exc()
        db.rollback()
    finally:
        db.close()
if __name__ == '__main__':
    import sys
    request_id = None
    if len(sys.argv) > 1:
        try:
            request_id = int(sys.argv[1])
        except ValueError:
            print('❌ Неверный ID заявки. Использование: python generate_invoice_script.py [request_id]')
            sys.exit(1)
    generate_invoice_for_request(request_id)
