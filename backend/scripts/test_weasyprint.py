"""Тестовый скрипт для проверки WeasyPrint с кириллицей"""
from weasyprint import HTML
from io import BytesIO
from pathlib import Path
html_content = '\n<!DOCTYPE html>\n<html lang="ru">\n<head>\n    <meta charset="utf-8">\n    <style>\n        @page {\n            size: A4;\n            margin: 20mm;\n        }\n        body {\n            font-family: "DejaVu Sans", sans-serif;\n            font-size: 12pt;\n            line-height: 1.4;\n        }\n        h1 {\n            text-align: center;\n            color: #333;\n        }\n        .info {\n            margin: 20px 0;\n            padding: 10px;\n            border: 1px solid #ccc;\n        }\n    </style>\n</head>\n<body>\n    <h1>ДОВЕРЕННОСТЬ № 1</h1>\n    \n    <div class="info">\n        <p><strong>Маршрут:</strong> Богданово → Актау</p>\n        <p><strong>Перевозчик:</strong> ООО "Транспортная компания"</p>\n        <p><strong>Водитель:</strong> Иванов Иван Иванович</p>\n        <p><strong>Паспорт:</strong> АБ 1234567, выдан УВД г. Алматы</p>\n        <p><strong>Телефон:</strong> +7 777 123 45 67</p>\n        <p><strong>Транспорт:</strong> Тягач МАЗ 1234 АА, Полуприцеп 5678 ББ</p>\n        <p><strong>Груз:</strong> Строительные материалы, 20 тонн</p>\n        <p><strong>Дата погрузки:</strong> 05 января 2025 г. в 10:00</p>\n    </div>\n    \n    <p>Настоящая доверенность выдана для получения груза по указанному маршруту.</p>\n    \n    <p style="margin-top: 30px;">\n        <strong>Руководитель:</strong> И.И. Иванов<br>\n        <strong>Дата выдачи:</strong> 05 января 2025 г.<br>\n        <strong>Действует до:</strong> 15 января 2025 г.\n    </p>\n</body>\n</html>\n'
print('🔄 Генерирую PDF с кириллицей...')
try:
    pdf_buffer = BytesIO()
    HTML(string=html_content, base_url=str(Path.cwd())).write_pdf(pdf_buffer)
    pdf_bytes = pdf_buffer.getvalue()
    pdf_buffer.close()
    output_file = Path('test_power_of_attorney.pdf')
    output_file.write_bytes(pdf_bytes)
    file_size = len(pdf_bytes)
    print(f'✅ PDF успешно создан!')
    print(f'📄 Файл: {output_file.absolute()}')
    print(f'📊 Размер: {file_size:,} байт ({file_size / 1024:.2f} KB)')
    print(f'\n🎉 WeasyPrint работает корректно с кириллицей!')
except Exception as e:
    print(f'❌ Ошибка: {e}')
    import traceback
    traceback.print_exc()
