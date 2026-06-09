"""
Модуль для работы с API портала «Открытые данные» (data.egov.kz)

Используется для получения данных о юридических лицах по БИН.
Соблюдает лимит 40 запросов в минуту и кэширует данные.
"""
import os
import httpx
import json
from datetime import datetime, timedelta
from typing import Optional, Dict, Any
from sqlalchemy.orm import Session
from database import Base, engine
from sqlalchemy import Column, String, Text, DateTime, Integer
from dotenv import load_dotenv
load_dotenv()
EGOV_API_KEY = os.getenv('EGOV_API_KEY')
EGOV_API_BASE_URL = 'https://data.egov.kz/api/v4'
MAX_REQUESTS_PER_MINUTE = 40
request_timestamps = []

class EgovDataCache(Base):
    """Таблица для кэширования данных из data.egov.kz"""
    __tablename__ = 'egov_data_cache'
    id = Column(Integer, primary_key=True, index=True)
    bin = Column(String, unique=True, index=True, nullable=False)
    data = Column(Text, nullable=False)
    cached_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    expires_at = Column(DateTime, nullable=False)

    def __repr__(self):
        return f'<EgovDataCache(bin={self.bin}, expires_at={self.expires_at})>'

def check_rate_limit() -> bool:
    """
    Проверяет, не превышен ли лимит запросов (40 в минуту).
    Возвращает True, если можно делать запрос.
    """
    global request_timestamps
    now = datetime.utcnow()
    request_timestamps = [ts for ts in request_timestamps if (now - ts).total_seconds() < 60]
    if len(request_timestamps) >= MAX_REQUESTS_PER_MINUTE:
        return False
    request_timestamps.append(now)
    return True

def get_cached_data(bin: str, db: Session) -> Optional[Dict[str, Any]]:
    """
    Получает данные из кэша, если они еще не истекли.
    
    Args:
        bin: БИН компании
        db: Сессия базы данных
    
    Returns:
        Словарь с данными или None, если данных нет в кэше или они истекли
    """
    cache_entry = db.query(EgovDataCache).filter(EgovDataCache.bin == bin).first()
    if cache_entry and cache_entry.expires_at > datetime.utcnow():
        try:
            return json.loads(cache_entry.data)
        except json.JSONDecodeError:
            db.delete(cache_entry)
            db.commit()
            return None
    if cache_entry:
        db.delete(cache_entry)
        db.commit()
    return None

def save_to_cache(bin: str, data: Dict[str, Any], db: Session, cache_hours: int=24):
    """
    Сохраняет данные в кэш.
    
    Args:
        bin: БИН компании
        data: Данные для кэширования
        db: Сессия базы данных
        cache_hours: Время кэширования в часах (по умолчанию 24)
    """
    expires_at = datetime.utcnow() + timedelta(hours=cache_hours)
    old_entry = db.query(EgovDataCache).filter(EgovDataCache.bin == bin).first()
    if old_entry:
        db.delete(old_entry)
    cache_entry = EgovDataCache(bin=bin, data=json.dumps(data, ensure_ascii=False), cached_at=datetime.utcnow(), expires_at=expires_at)
    db.add(cache_entry)
    db.commit()

def search_companies_by_activity(keywords: list, db: Session, limit: int=100) -> list:
    """
    Поиск компаний по ключевым словам в названии или виду деятельности.
    
    Использует поиск по названию компании через API data.egov.kz.
    Ищет компании, связанные с логистикой и перевозками.
    
    Args:
        keywords: Список ключевых слов для поиска (например, ["груз", "перевоз", "транспорт", "логистик"])
        db: Сессия базы данных
        limit: Максимальное количество результатов
    
    Returns:
        Список компаний, соответствующих критериям поиска
    """
    if not EGOV_API_KEY:
        print('⚠️ Предупреждение: EGOV_API_KEY не установлен в .env файле')
        return []
    if not check_rate_limit():
        print('⚠️ Превышен лимит запросов (40/минуту)')
        return []
    api_url = f'{EGOV_API_BASE_URL}/gbd_ul/v1'
    query = {'size': limit, 'query': {'match': {'nameru': keywords[0] if keywords else 'груз'}}}
    try:
        with httpx.Client(timeout=30.0) as client:
            print(f'🔍 Отправка запроса к API: {api_url}')
            print(f'📝 Query: {json.dumps(query, ensure_ascii=False, indent=2)}')
            response = client.get(api_url, params={'apiKey': EGOV_API_KEY, 'source': json.dumps(query)})
            print(f'📡 Ответ API: статус={response.status_code}')
            if response.status_code == 200:
                data = response.json()
                print(f"📊 API вернул данные: тип={type(data)}, длина={(len(data) if isinstance(data, list) else 'N/A')}")
                if isinstance(data, list):
                    filtered_results = []
                    keywords_lower = [kw.lower() for kw in keywords]
                    for company in data:
                        company_name = (company.get('nameru', '') + ' ' + company.get('namekk', '') + ' ' + company.get('namekz', '')).lower()
                        if any((kw in company_name for kw in keywords_lower)):
                            filtered_results.append(company)
                    print(f'✅ Найдено {len(filtered_results)} компаний по ключевым словам: {keywords}')
                    if len(filtered_results) == 0 and len(data) > 0:
                        print(f'⚠️ API вернул {len(data)} компаний, но ни одна не прошла фильтрацию по ключевым словам')
                        print(f"Пример названий: {[c.get('nameru', '')[:50] for c in data[:3]]}")
                    return filtered_results[:limit]
                else:
                    print(f'ℹ️ API вернул неожиданный формат данных: {type(data)}')
                    print(f'Данные: {str(data)[:500]}')
                    return []
            else:
                print(f'❌ Ошибка API: статус {response.status_code}, ответ: {response.text}')
                return []
    except httpx.TimeoutException:
        print('❌ Таймаут при запросе к API data.egov.kz')
        return []
    except httpx.RequestError as e:
        print(f'❌ Ошибка при запросе к API: {e}')
        return []
    except Exception as e:
        print(f'❌ Неожиданная ошибка: {e}')
        import traceback
        traceback.print_exc()
        return []

def get_company_by_bin(bin: str, db: Session) -> Optional[Dict[str, Any]]:
    """
    Получает данные о компании по БИН из API data.egov.kz.
    
    Сначала проверяет кэш, затем делает запрос к API (если не превышен лимит).
    
    Примечание: API data.egov.kz работает только с БИН (для юридических лиц и ИП).
    ИИН (для физических лиц) не поддерживается этим API.
    
    Args:
        bin: БИН компании (12 цифр) или ИИН (12 цифр)
        db: Сессия базы данных
    
    Returns:
        Словарь с данными о компании или None в случае ошибки
    
    Пример ответа:
        {
            "bin": "123456789012",
            "nameru": "ТОО Пример",
            "addressru": "г. Алматы, ул. Примерная, 1",
            "statusru": "Действующий",
            "director": "Иванов Иван Иванович",
            "datereg": "01.01.2020",
            ...
        }
    """
    if not EGOV_API_KEY:
        print('⚠️ Предупреждение: EGOV_API_KEY не установлен в .env файле')
        return None
    cached_data = get_cached_data(bin, db)
    if cached_data:
        print(f'✅ Данные по БИН {bin} получены из кэша')
        return cached_data
    if not check_rate_limit():
        print('⚠️ Превышен лимит запросов (40/минуту). Используйте кэшированные данные.')
        return None
    api_url = f'{EGOV_API_BASE_URL}/gbd_ul/v1'
    query = {'size': 1, 'query': {'match': {'bin': bin}}}
    try:
        with httpx.Client(timeout=10.0) as client:
            response = client.get(api_url, params={'apiKey': EGOV_API_KEY, 'source': json.dumps(query)})
            if response.status_code == 200:
                data = response.json()
                if isinstance(data, list) and len(data) > 0:
                    company_data = data[0]
                    save_to_cache(bin, company_data, db)
                    print(f'✅ Данные по БИН {bin} получены из API и сохранены в кэш')
                    return company_data
                else:
                    print(f'ℹ️ Компания с БИН {bin} не найдена. Примечание: API поддерживает только БИН (для юр. лиц и ИП). Если вы ввели ИИН (для физ. лиц), проверка недоступна.')
                    return None
            else:
                print(f'❌ Ошибка API: статус {response.status_code}, ответ: {response.text}')
                return None
    except httpx.TimeoutException:
        print('❌ Таймаут при запросе к API data.egov.kz')
        return None
    except httpx.RequestError as e:
        print(f'❌ Ошибка при запросе к API: {e}')
        return None
    except Exception as e:
        print(f'❌ Неожиданная ошибка: {e}')
        return None

def verify_company_data(user_bin: str, user_company_name: str, db: Session) -> Dict[str, Any]:
    """
    Верифицирует данные компании, сравнивая их с официальными данными из реестра.
    
    Args:
        user_bin: БИН, указанный пользователем
        user_company_name: Название компании, указанное пользователем
        db: Сессия базы данных
    
    Returns:
        Словарь с результатами верификации:
        {
            "verified": bool,
            "match": bool,
            "official_data": dict или None,
            "message": str
        }
    """
    official_data = get_company_by_bin(user_bin, db)
    if not official_data:
        return {'verified': False, 'match': False, 'official_data': None, 'message': 'Компания с указанным БИН не найдена в реестре'}
    status = official_data.get('statusru', '').lower()
    if 'ликвидирован' in status or 'прекращен' in status:
        return {'verified': False, 'match': False, 'official_data': official_data, 'message': f"Компания имеет статус: {official_data.get('statusru')}"}
    official_name = official_data.get('nameru', '').lower().strip()
    user_name = user_company_name.lower().strip()
    name_match = user_name in official_name or official_name in user_name
    return {'verified': True, 'match': name_match, 'official_data': official_data, 'message': 'Данные верифицированы' if name_match else 'Название компании не совпадает с реестром'}

def init_cache_table():
    """Создает таблицу для кэширования, если она еще не существует"""
    Base.metadata.create_all(bind=engine, tables=[EgovDataCache.__table__])
init_cache_table()
