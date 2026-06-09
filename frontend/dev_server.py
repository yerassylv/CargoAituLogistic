#!/usr/bin/env python3
"""
Простой HTTP сервер для frontend с поддержкой кеширования статических файлов.
Использование: python3 dev_server.py (или python3 server.py)
"""

import http.server
import socketserver
from pathlib import Path
from urllib.parse import urlparse, parse_qs

class CachedHTTPRequestHandler(http.server.SimpleHTTPRequestHandler):
    """HTTP Request Handler с поддержкой кеширования статических файлов"""
    
    def end_headers(self):
        # Добавляем Cache-Control заголовки для статических файлов
        path = urlparse(self.path).path
        query = parse_qs(urlparse(self.path).query)
        
        if path.endswith(('.js', '.css', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.woff', '.woff2', '.ttf', '.eot')):
            # Кешируем на 1 год для файлов с версией
            if 'v' in query or 'version' in query:
                self.send_header('Cache-Control', 'public, max-age=31536000, immutable')
            else:
                # Для файлов без версии - 1 час
                self.send_header('Cache-Control', 'public, max-age=3600')
        
        # Вызываем родительский метод для отправки остальных заголовков
        super().end_headers()
    
    def log_message(self, format, *args):
        # Убираем лишние логи для чистоты вывода
        pass

def run_server(port=8080):
    """Запуск HTTP сервера на указанном порту"""
    handler = CachedHTTPRequestHandler
    
    try:
        with socketserver.TCPServer(("", port), handler) as httpd:
            print(f"🚀 Frontend сервер запущен на http://localhost:{port}")
            print(f"📁 Обслуживает файлы из: {Path(__file__).parent.absolute()}")
            print(f"💾 Кеширование статических файлов включено")
            print(f"\nНажмите Ctrl+C для остановки\n")
            try:
                httpd.serve_forever()
            except KeyboardInterrupt:
                print("\n\n👋 Сервер остановлен")
    except OSError as e:
        if e.errno == 48:  # Address already in use
            print(f"❌ Ошибка: Порт {port} уже занят!")
            print(f"💡 Решения:")
            print(f"   1. Найдите и остановите процесс: lsof -ti:{port} | xargs kill -9")
            print(f"   2. Или используйте другой порт: python3 dev_server.py 8081")
            print(f"   3. Или подождите несколько секунд и попробуйте снова")
        else:
            print(f"❌ Ошибка при запуске сервера: {e}")
        raise

if __name__ == "__main__":
    import sys
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    run_server(port)
