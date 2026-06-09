from fastapi import FastAPI, Depends, HTTPException, UploadFile, File, Form, Header, Request, Query, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, Response, HTMLResponse
from sqlalchemy.orm import Session
from sqlalchemy import func, or_, text
from sqlalchemy.orm import joinedload
from typing import Optional, List
from pydantic import BaseModel
import os
import base64
import httpx
import json
import warnings
import secrets
import re
import time
from datetime import datetime, timedelta, timezone
from jinja2 import Template, Environment, FileSystemLoader
from pathlib import Path
from cryptography import x509
from cryptography.hazmat.backends import default_backend
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding
from cryptography.hazmat.primitives.serialization import pkcs7
from OpenSSL import crypto
from lxml import etree
import googlemaps
from groq import Groq
from dotenv import load_dotenv
load_dotenv()
try:
    import urllib3
    urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
except ImportError:
    pass
from database import init_db, get_db, SessionLocal, User, UsedNonce, Request, Bid, Driver, Vehicle, Notification, RequestStatus, RequestHistory, Contract, ContractStatus, Partnership, PartnershipStatus
from models import UserRegistration, UserResponse, RegistrationResponse, NonceResponse, VerifyRequest, AuthResponse, CertificateData, RequestCreate, RequestResponse, RequestResponseWithBids, BidCreate, BidUpdate, BidResponse, DriverCreate, DriverResponse, VehicleCreate, VehicleResponse, NotificationResponse, RequestHistoryResponse, ContractResponse, PaymentDetailsUpdate, PartnershipResponse, PartnershipCreate, PartnershipSign, OrganizationResponse
from ecp_utils import save_certificate, extract_certificate_info, verify_certificate
from vehicle_constants import meta_vehicle_enums, vehicle_to_response_dict, persist_labels_from_codes, vehicle_body_display_label, vehicle_composition_display_label, resolve_composition_code
AUCTION_START_GRACE = timedelta(minutes=2)

def naive_utc(dt: Optional[datetime]) -> Optional[datetime]:
    """Приводит datetime к наивному UTC. Клиент шлёт ISO с Z (aware); сервер сравнивает с datetime.utcnow() (naive)."""
    if dt is None:
        return None
    if dt.tzinfo is None:
        return dt
    return dt.astimezone(timezone.utc).replace(tzinfo=None)

def normalize_auction_type(_auction_type: Optional[str]) -> str:
    """В продукте только открытый аукцион; значение BLIND с клиента приводится к OPEN."""
    return 'OPEN'
BID_PRICE_GRID_STEP_TENGE = 10000

def assert_bid_price_tenge_grid(price: float, step: int=BID_PRICE_GRID_STEP_TENGE) -> None:
    """Ставка должна быть кратна step ₸ (целые тенге)."""
    if step <= 0:
        return
    tenge = int(round(price))
    if tenge % step != 0:
        raise HTTPException(status_code=400, detail=f'Сумма ставки должна быть кратна {step} ₸')

def validate_bid_price_against_request(request: Request, price: float) -> None:
    if request.max_price is not None and price > request.max_price:
        raise HTTPException(status_code=400, detail=f'Ставка не может быть выше максимальной цены заявки ({request.max_price} ₸)')

def validate_auction_schedule(now: datetime, bidding_started_at: datetime, bidding_ends_at: datetime) -> None:
    if bidding_ends_at <= bidding_started_at:
        raise HTTPException(status_code=400, detail='Окончание приёма ставок должно быть позже начала')
    if bidding_started_at < now - AUCTION_START_GRACE:
        raise HTTPException(status_code=400, detail='Начало приёма ставок не может быть в прошлом')
    if bidding_ends_at <= now:
        raise HTTPException(status_code=400, detail='Окончание приёма ставок должно быть в будущем')

def apply_request_bidding_defaults(req: Request, *, now: datetime) -> None:
    """Дополняет окно аукциона значениями по умолчанию (как при создании заявки)."""
    if req.bidding_started_at is None:
        req.bidding_started_at = now
    if req.bidding_ends_at is None:
        hours = 2 if req.is_express else 24
        req.bidding_ends_at = req.bidding_started_at + timedelta(hours=hours)

def compute_bidding_accepting(request: Request, now: Optional[datetime]=None) -> bool:
    if request.status != RequestStatus.ACTIVE.value:
        return False
    n = now or datetime.utcnow()
    if request.bidding_started_at and n < request.bidding_started_at:
        return False
    if request.bidding_ends_at and n > request.bidding_ends_at:
        return False
    return True

def enrich_request_response(response: RequestResponse, req: Request) -> None:
    response.bidding_accepting = compute_bidding_accepting(req)

def sanitize_request_response_for_non_participant(response: RequestResponse, user_id: Optional[int], request: Request) -> None:
    """Скрывает конфиденциальные документы от пользователей, не участвующих в сделке"""
    is_customer = user_id and user_id == request.customer_id
    is_carrier = user_id and request.selected_carrier_id and user_id == request.selected_carrier_id

    if not (is_customer or is_carrier):
        # Скрываем пути к документам от не-участников
        response.act_path = None
        response.signed_act_path = None
        response.act_signature_xml = None
        response.act_signature_cert_data = None
        response.invoice_path = None

def _user_can_access_request_documents(user_id: int, request: Request) -> bool:
    return user_id == request.customer_id or user_id == request.selected_carrier_id

def _resolve_document_request_context(file_path: str, db: Session) -> tuple[Optional[Request], Optional[Contract], str]:
    """Определяет, к какой заявке/контракту относится документ."""
    normalized = file_path.replace("\\", "/").lstrip("/")
    normalized_no_prefix = normalized[len("contracts/"):] if normalized.startswith("contracts/") else normalized
    normalized_variants = {
        normalized,
        normalized_no_prefix,
        f'contracts/{normalized}',
        f'contracts/{normalized_no_prefix}',
    }
    document_kind = "unknown"
    request_obj: Optional[Request] = None
    contract_obj: Optional[Contract] = None

    # Сначала пытаемся найти документ по точному значению, которое уже хранится в БД.
    exact_contract = db.query(Contract).filter(
        or_(
            Contract.document_path.in_(normalized_variants),
            Contract.signed_document_path.in_(normalized_variants),
            Contract.power_of_attorney_path.in_(normalized_variants),
            Contract.signed_power_of_attorney_path.in_(normalized_variants),
        )
    ).first()
    if exact_contract:
        contract_obj = exact_contract
        request_obj = db.query(Request).filter(Request.id == exact_contract.request_id).first()
        if exact_contract.signed_document_path in {normalized, normalized_no_prefix} or exact_contract.document_path in {normalized, normalized_no_prefix}:
            document_kind = "contract"
        elif exact_contract.signed_power_of_attorney_path in {normalized, normalized_no_prefix} or exact_contract.power_of_attorney_path in {normalized, normalized_no_prefix}:
            document_kind = "power_of_attorney"
        return request_obj, contract_obj, document_kind

    exact_request = db.query(Request).filter(
        or_(
            Request.act_path.in_(normalized_variants),
            Request.signed_act_path.in_(normalized_variants),
            Request.invoice_path.in_(normalized_variants),
        )
    ).first()
    if exact_request:
        request_obj = exact_request
        contract_obj = db.query(Contract).filter(Contract.request_id == exact_request.id).first()
        if exact_request.signed_act_path in {normalized, normalized_no_prefix} or exact_request.act_path in {normalized, normalized_no_prefix}:
            document_kind = "act"
        elif exact_request.invoice_path in {normalized, normalized_no_prefix}:
            document_kind = "invoice"
        return request_obj, contract_obj, document_kind

    contract_match = re.search(r'(?:^|/)contract_(\d+)(?:_|\.|$)', normalized)
    if contract_match:
        document_kind = "contract"
        contract_id = int(contract_match.group(1))
        contract_obj = db.query(Contract).filter(Contract.id == contract_id).first()
        if contract_obj:
            request_obj = db.query(Request).filter(Request.id == contract_obj.request_id).first()
        return request_obj, contract_obj, document_kind

    request_contract_match = re.search(r'(?:^|/)request_(\d+)_contract_(?:\d{8}_\d{6}|\d+)(?:_|\.|$)', normalized)
    if request_contract_match:
        document_kind = "contract"
        request_id = int(request_contract_match.group(1))
        request_obj = db.query(Request).filter(Request.id == request_id).first()
        if request_obj:
            contract_obj = db.query(Contract).filter(Contract.request_id == request_id).first()
        return request_obj, contract_obj, document_kind

    act_match = re.search(r'(?:^|/)act_(\d+)(?:_|\.|$)', normalized)
    if act_match:
        document_kind = "act"
        request_id = int(act_match.group(1))
        request_obj = db.query(Request).filter(Request.id == request_id).first()
        if request_obj:
            contract_obj = db.query(Contract).filter(Contract.request_id == request_id).first()
        return request_obj, contract_obj, document_kind

    invoice_match = re.search(r'(?:^|/)invoice_(\d+)(?:_|\.|$)', normalized)
    if invoice_match:
        document_kind = "invoice"
        request_id = int(invoice_match.group(1))
        request_obj = db.query(Request).filter(Request.id == request_id).first()
        if request_obj:
            contract_obj = db.query(Contract).filter(Contract.request_id == request_id).first()
        return request_obj, contract_obj, document_kind

    poa_match = re.search(r'(?:^|/)power_of_attorney_(\d+)(?:_|\.|$)', normalized)
    if poa_match:
        document_kind = "power_of_attorney"
        contract_id = int(poa_match.group(1))
        contract_obj = db.query(Contract).filter(Contract.id == contract_id).first()
        if contract_obj:
            request_obj = db.query(Request).filter(Request.id == contract_obj.request_id).first()
        return request_obj, contract_obj, document_kind

    return None, None, document_kind
app = FastAPI(title='CargoAitu - Платформа автоматизации грузоперевозок')
_jinja_env = None

def get_jinja_env():
    """Получение кешированного окружения Jinja2"""
    global _jinja_env
    if _jinja_env is None:
        template_dir = Path(__file__).parent / 'templates'
        _jinja_env = Environment(loader=FileSystemLoader(str(template_dir)), autoescape=True, auto_reload=False)
    return _jinja_env

@app.on_event('startup')
async def startup_event():
    init_db()
    try:
        import egov_api
        print('✅ Модуль egov_api загружен, таблица кэша создана')
    except Exception as e:
        print(f'⚠️ Предупреждение: не удалось загрузить egov_api: {e}')
    get_jinja_env()
frontend_origins = [
    origin.strip()
    for origin in os.getenv(
        'FRONTEND_ORIGINS',
        'http://localhost:8080,http://127.0.0.1:8080,https://cargoaitulogistic-1.onrender.com'
    ).split(',')
    if origin.strip()
]
app.add_middleware(CORSMiddleware, allow_origins=frontend_origins, allow_credentials=True, allow_methods=['*'], allow_headers=['*'])
app.add_middleware(GZipMiddleware, minimum_size=1000)

@app.middleware('http')
async def add_cache_headers(request: Request, call_next):
    response = await call_next(request)
    path = request.url.path
    if path.endswith(('.js', '.css', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.woff', '.woff2', '.ttf', '.eot')):
        query_string = str(request.url.query)
        if 'v=' in query_string or 'version=' in query_string:
            response.headers['Cache-Control'] = 'public, max-age=31536000, immutable'
        else:
            response.headers['Cache-Control'] = 'public, max-age=3600'
    return response
import os
from pathlib import Path
project_root = Path(__file__).parent.parent
assets_dir = project_root / 'assets'
frontend_dir = project_root / 'frontend'
if assets_dir.exists():
    app.mount('/assets', StaticFiles(directory=str(assets_dir)), name='assets')

@app.get('/')
async def root():
    return {'message': 'CargoAitu API работает!'}

@app.get('/api/health')
async def health_check():
    return {'status': 'ok', 'service': 'CargoAitu'}

@app.get('/api/google-maps-key')
async def get_google_maps_key():
    """Возвращает Google Maps API ключ для использования на frontend"""
    google_maps_key = os.getenv('GOOGLE_MAPS_API_KEY')
    if not google_maps_key:
        raise HTTPException(status_code=404, detail='Google Maps API ключ не настроен')
    return {'key': google_maps_key}

@app.post('/api/extract-certificate')
async def extract_certificate_data(ecp_certificate: UploadFile=File(...), password: Optional[str]=Form(None)):
    """
    Извлекает данные из сертификата ЭЦП для предварительного просмотра
    Пользователь может увидеть, какие данные будут извлечены перед регистрацией
    """
    try:
        certificate_content = await ecp_certificate.read()
        is_valid, message = verify_certificate(certificate_content, ecp_certificate.filename)
        if not is_valid:
            raise HTTPException(status_code=400, detail=f'Ошибка проверки сертификата: {message}')
        cert_info = extract_certificate_info(certificate_content, ecp_certificate.filename, password)
        return {'success': True, 'data': cert_info, 'message': 'Данные успешно извлечены из сертификата'}
    except Exception as e:
        raise HTTPException(status_code=400, detail=f'Ошибка при извлечении данных: {str(e)}')

@app.post('/api/register', response_model=RegistrationResponse)
async def register_user(ecp_certificate: UploadFile=File(...), password: Optional[str]=Form(None), db: Session=Depends(get_db)):
    """
    Регистрация пользователя с ЭЦП сертификатом
    Все данные автоматически извлекаются из сертификата
    """
    try:
        certificate_content = await ecp_certificate.read()
        is_valid, message = verify_certificate(certificate_content, ecp_certificate.filename)
        if not is_valid:
            raise HTTPException(status_code=400, detail=f'Ошибка проверки сертификата: {message}')
        cert_info = extract_certificate_info(certificate_content, ecp_certificate.filename, password)
        existing_user = db.query(User).filter((User.email == cert_info['email']) | (User.ecp_serial_number == cert_info['serial_number'])).first()
        if existing_user:
            raise HTTPException(status_code=400, detail='Пользователь с таким сертификатом уже зарегистрирован')
        cert_path, cert_id = save_certificate(certificate_content, cert_info['serial_number'])
        new_user = User(email=cert_info['email'], full_name=cert_info['full_name'], company_name=cert_info.get('company_name'), phone=cert_info.get('phone'), iin=cert_info.get('inn') or '', bin=cert_info.get('bin') or None, cert_serial=cert_info['serial_number'], cert_issuer=cert_info['issuer'], cert_valid_from=cert_info['valid_from'], cert_valid_to=cert_info['valid_to'])
        db.add(new_user)
        db.commit()
        db.refresh(new_user)
        return RegistrationResponse(success=True, message='Регистрация успешно завершена! Данные извлечены из сертификата ЭЦП.', user=UserResponse(id=new_user.id, email=new_user.email, full_name=new_user.full_name, company_name=new_user.company_name, phone=new_user.phone, iin=new_user.iin, bin=new_user.bin, ecp_serial_number=new_user.ecp_serial_number, ecp_verified=new_user.ecp_verified, created_at=new_user.created_at))
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f'Ошибка при сохранении пользователя: {str(e)}')

@app.get('/api/users', response_model=List[UserResponse])
async def get_users(db: Session=Depends(get_db)):
    """Получить список всех пользователей"""
    users = db.query(User).filter(User.is_active == True).all()
    return users

@app.get('/api/users/{user_id}', response_model=UserResponse)
async def get_user(user_id: int, db: Session=Depends(get_db)):
    """Получить информацию о пользователе"""
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail='Пользователь не найден')
    return user

class NCALayerCertificateData(BaseModel):
    """Данные сертификата из NCALayer"""
    full_name: str
    email: str
    company_name: Optional[str] = None
    inn: Optional[str] = None
    bin: Optional[str] = None
    phone: Optional[str] = None
    serial_number: str
    issuer: str
    valid_from: str
    valid_to: str
    is_valid: bool
    certificate_base64: Optional[str] = None

@app.post('/api/register-ncalayer', response_model=RegistrationResponse)
async def register_user_ncalayer(cert_data: NCALayerCertificateData, db: Session=Depends(get_db)):
    """
    Регистрация пользователя через NCALayer
    Данные сертификата передаются напрямую из браузера
    """
    try:
        existing_user = db.query(User).filter((User.email == cert_data.email) | (User.ecp_serial_number == cert_data.serial_number)).first()
        if existing_user:
            raise HTTPException(status_code=400, detail='Пользователь с таким сертификатом уже зарегистрирован')
        from datetime import datetime
        try:
            valid_from = datetime.fromisoformat(cert_data.valid_from.replace('Z', '+00:00'))
            valid_to = datetime.fromisoformat(cert_data.valid_to.replace('Z', '+00:00'))
        except:
            valid_from = datetime.now()
            valid_to = datetime(2025, 12, 31)
        cert_path = None
        if cert_data.certificate_base64:
            try:
                certificate_content = base64.b64decode(cert_data.certificate_base64)
                cert_path, _ = save_certificate(certificate_content, cert_data.serial_number)
            except:
                pass
        new_user = User(email=cert_data.email, full_name=cert_data.full_name, company_name=cert_data.company_name, phone=cert_data.phone, iin=cert_data.inn or '', bin=cert_data.bin if hasattr(cert_data, 'bin') and cert_data.bin else None, cert_serial=cert_data.serial_number, cert_issuer=cert_data.issuer, cert_valid_from=valid_from.replace(tzinfo=None) if valid_from.tzinfo else valid_from, cert_valid_to=valid_to.replace(tzinfo=None) if valid_to.tzinfo else valid_to)
        db.add(new_user)
        db.commit()
        db.refresh(new_user)
        return RegistrationResponse(success=True, message='Регистрация успешно завершена через NCALayer!', user=UserResponse(id=new_user.id, email=new_user.email, full_name=new_user.full_name, company_name=new_user.company_name, phone=new_user.phone, iin=new_user.iin, bin=new_user.bin, cert_serial=new_user.cert_serial, created_at=new_user.created_at))
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f'Ошибка при сохранении пользователя: {str(e)}')
NCALAYER_URL = 'https://127.0.0.1:13579'

@app.get('/api/ncalayer/check')
async def check_ncalayer():
    """
    Проверка доступности NCALayer
    Бэкенд проверяет, запущено ли приложение NCALayer на локальной машине
    """
    try:
        async with httpx.AsyncClient(timeout=3.0, verify=False) as client:
            endpoints_to_try = ['/', '/info', '/status', '/health']
            for endpoint in endpoints_to_try:
                try:
                    response = await client.get(f'{NCALAYER_URL}{endpoint}', timeout=2.0)
                    if response.status_code in [200, 404, 405]:
                        return {'available': True, 'message': f'NCALayer доступен (статус: {response.status_code})'}
                except httpx.HTTPStatusError as e:
                    if e.response.status_code in [404, 405, 500]:
                        return {'available': True, 'message': f'NCALayer доступен (статус: {e.response.status_code})'}
                except (httpx.ConnectError, httpx.TimeoutException):
                    raise
                except:
                    continue
            return {'available': True, 'message': 'NCALayer доступен (соединение установлено)'}
    except (httpx.ConnectError, httpx.TimeoutException):
        return {'available': False, 'message': 'NCALayer не запущен или недоступен. Запустите приложение NCALayer.'}
    except Exception as e:
        return {'available': False, 'message': f'Ошибка при проверке: {str(e)}'}

@app.post('/api/ncalayer/get-certificate')
async def get_ncalayer_certificate():
    """
    Получение данных сертификата из NCALayer
    Бэкенд обращается к локальному приложению NCALayer и извлекает данные сертификата
    """
    try:
        async with httpx.AsyncClient(timeout=15.0, verify=False) as client:
            endpoints_to_try = [('POST', '/getCertificates', {}), ('POST', '/getCertificate', {}), ('POST', '/api/getCertificates', {}), ('POST', '/api/getCertificate', {}), ('GET', '/getCertificates', None), ('GET', '/getCertificate', None), ('GET', '/api/getCertificates', None), ('GET', '/api/getCertificate', None), ('POST', '/certificates', {}), ('GET', '/certificates', None), ('POST', '/v1/certificates', {}), ('GET', '/v1/certificates', None), ('POST', '/ncalayer/getCertificates', {}), ('POST', '/ncalayer/getCertificate', {}), ('POST', '/getCertificates', {'type': 'all'}), ('POST', '/getCertificate', {'index': 0})]
            last_error = None
            for method, endpoint, data in endpoints_to_try:
                try:
                    if method == 'POST':
                        response = await client.post(f'{NCALAYER_URL}{endpoint}', json=data if data else {}, timeout=10.0)
                    else:
                        response = await client.get(f'{NCALAYER_URL}{endpoint}', timeout=10.0)
                    if response.status_code in [200, 201]:
                        try:
                            try:
                                certs_data = response.json()
                            except:
                                text_response = response.text
                                if text_response:
                                    import json as json_lib
                                    certs_data = json_lib.loads(text_response)
                                else:
                                    last_error = f'Пустой ответ от {endpoint}'
                                    continue
                            cert = None
                            if isinstance(certs_data, list) and len(certs_data) > 0:
                                cert = certs_data[0]
                            elif isinstance(certs_data, dict):
                                if 'certificates' in certs_data and certs_data['certificates']:
                                    cert = certs_data['certificates'][0]
                                elif 'certificate' in certs_data:
                                    cert = certs_data['certificate']
                                elif 'data' in certs_data:
                                    cert = certs_data['data']
                                elif 'result' in certs_data:
                                    cert = certs_data['result']
                                else:
                                    cert = certs_data
                            if cert:
                                cert_info = parse_ncalayer_certificate(cert)
                                return {'success': True, 'certificate': cert_info}
                            else:
                                last_error = f'Не найдены данные сертификата в ответе от {endpoint}'
                        except Exception as parse_error:
                            last_error = f'Ошибка парсинга ответа от {endpoint}: {str(parse_error)}'
                            continue
                    elif response.status_code == 404:
                        last_error = f'404 Not Found: {endpoint}'
                        continue
                    elif response.status_code == 405:
                        last_error = f'405 Method Not Allowed: {endpoint}'
                        continue
                except httpx.HTTPStatusError as e:
                    try:
                        error_body = e.response.text[:200]
                        last_error = f'HTTP {e.response.status_code}: {endpoint} - {error_body}'
                    except:
                        last_error = f'HTTP {e.response.status_code}: {endpoint}'
                    continue
                except Exception as e:
                    last_error = f'Ошибка {endpoint}: {str(e)}'
                    continue
            error_detail = f'Не удалось получить сертификат из NCALayer через HTTP API. '
            if last_error:
                error_detail += f'\n\nПоследняя попытка: {last_error}\n'
            error_detail += '\nВозможные причины:\n'
            error_detail += '1. NCALayer может использовать WebSocket или специальный протокол (не HTTP REST API)\n'
            error_detail += '2. Требуется специальная JavaScript библиотека для работы с NCALayer\n'
            error_detail += '3. Проверьте, что на сайте egov.kz NCALayer работает - если там работает, значит проблема в API endpoints\n\n'
            error_detail += "Рекомендация: Используйте способ 'Загрузка файла' для регистрации, если NCALayer API недоступен."
            raise HTTPException(status_code=503, detail=error_detail)
    except httpx.ConnectError:
        raise HTTPException(status_code=503, detail='NCALayer не запущен. Запустите приложение NCALayer на вашем компьютере.')
    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail='Таймаут при обращении к NCALayer. Проверьте подключение токена.')
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f'Ошибка при получении сертификата: {str(e)}')

def parse_ncalayer_certificate(cert_data: dict) -> dict:
    """
    Парсинг данных сертификата из NCALayer
    NCALayer может возвращать данные в разных форматах
    """
    from datetime import datetime, timedelta
    full_name = cert_data.get('subjectCN') or cert_data.get('commonName') or cert_data.get('CN') or cert_data.get('name') or 'Не указано'
    email = cert_data.get('email') or cert_data.get('emailAddress') or cert_data.get('E') or ''
    company_name = cert_data.get('organization') or cert_data.get('O') or cert_data.get('organizationName') or ''
    inn = cert_data.get('inn') or cert_data.get('serialNumber') or cert_data.get('INN') or ''
    serial_number = cert_data.get('serial') or cert_data.get('serialNumber') or cert_data.get('thumbprint') or cert_data.get('id') or 'UNKNOWN'
    issuer = cert_data.get('issuerCN') or cert_data.get('issuer') or cert_data.get('issuerName') or 'Неизвестный УЦ'
    valid_from = cert_data.get('validFrom') or cert_data.get('notBefore')
    valid_to = cert_data.get('validTo') or cert_data.get('notAfter')
    if isinstance(valid_from, str):
        try:
            valid_from = datetime.fromisoformat(valid_from.replace('Z', '+00:00'))
        except:
            valid_from = datetime.now()
    elif not valid_from:
        valid_from = datetime.now()
    if isinstance(valid_to, str):
        try:
            valid_to = datetime.fromisoformat(valid_to.replace('Z', '+00:00'))
        except:
            valid_to = datetime.now() + timedelta(days=365)
    elif not valid_to:
        valid_to = datetime.now() + timedelta(days=365)
    is_valid = cert_data.get('isValid', True)
    if isinstance(is_valid, bool):
        pass
    else:
        is_valid = datetime.now() < valid_to
    certificate_base64 = cert_data.get('certificate') or cert_data.get('base64') or cert_data.get('cert')
    return {'full_name': str(full_name), 'email': str(email) if email else f"{full_name.lower().replace(' ', '.')}@example.ru", 'company_name': str(company_name) if company_name else None, 'inn': str(inn) if inn else None, 'phone': None, 'serial_number': str(serial_number), 'issuer': str(issuer), 'valid_from': valid_from.isoformat() if isinstance(valid_from, datetime) else str(valid_from), 'valid_to': valid_to.isoformat() if isinstance(valid_to, datetime) else str(valid_to), 'is_valid': bool(is_valid), 'certificate_base64': certificate_base64}
active_nonces = {}

def generate_nonce() -> str:
    """Генерация криптографически стойкого одноразового nonce"""
    return secrets.token_urlsafe(32)

def verify_xml_signature(signed_xml: str, expected_nonce: str, cert_data: Optional[CertificateData]=None) -> bool:
    """
    Проверка XML подписи
    
    Args:
        signed_xml: Подписанный XML документ
        expected_nonce: Ожидаемый nonce
        cert_data: Данные сертификата для проверки (опционально)
    
    Returns:
        True если подпись валидна, False иначе
    """
    try:
        if not signed_xml.strip().startswith('<?xml'):
            return False
        try:
            root = etree.fromstring(signed_xml.encode('utf-8'))
            extracted_nonce = (root.text or '').strip()
            if not extracted_nonce or extracted_nonce != expected_nonce:
                return False
            ns = {'ds': 'http://www.w3.org/2000/09/xmldsig#'}
            signature_elem = root.find('.//ds:Signature', namespaces=ns)
            if signature_elem is None:
                return True
            return True
        except etree.XMLSyntaxError:
            return False
    except Exception as e:
        print(f'Ошибка при проверке XML подписи: {e}')
        import traceback
        traceback.print_exc()
        return False

def certificate_data_from_xml_signature_root(root) -> CertificateData:
    """
    Извлекает CertificateData из подписанного XML (корневой элемент после parse).
    Та же логика, что при верификации подписи контракта (X509Certificate в xmldsig).
    """
    x509_cert_elem = root.find('.//{http://www.w3.org/2000/09/xmldsig#}X509Certificate')
    if x509_cert_elem is None or not (x509_cert_elem.text or '').strip():
        raise ValueError('Сертификат не найден в подписи')
    cert_pem = x509_cert_elem.text.strip()
    cert_bytes = base64.b64decode(cert_pem)
    cert = x509.load_der_x509_certificate(cert_bytes, default_backend())
    subject = cert.subject
    issuer = cert.issuer
    iin = ''
    common_name = ''
    organization = ''
    email = ''
    for attr in subject:
        if attr.oid == x509.NameOID.COMMON_NAME:
            common_name = attr.value
        elif attr.oid == x509.NameOID.ORGANIZATION_NAME:
            organization = attr.value
        elif attr.oid == x509.NameOID.EMAIL_ADDRESS:
            email = attr.value
        oid_str = str(attr.oid)
        if '1.2.643.100.1' in oid_str or '1.2.398.3.3.1.1' in oid_str:
            iin = attr.value
    if not iin:
        for attr in subject:
            if attr.oid == x509.NameOID.SERIAL_NUMBER:
                value = attr.value
                if value.isdigit() and len(value) in [10, 12]:
                    iin = value
    return CertificateData(iin=iin or '', full_name=common_name or '', company_name=organization or None, email=email or None, serial_number=format(cert.serial_number, 'X'), issuer=issuer.rfc4514_string() if issuer else None, valid_from=cert.not_valid_before, valid_to=cert.not_valid_after)

def verify_cms_signature(signature_base64: str, data: bytes, cert_data: CertificateData) -> bool:
    """
    Проверка CMS подписи
    
    Args:
        signature_base64: CMS подпись в формате base64
        data: Исходные данные, которые были подписаны (nonce)
        cert_data: Данные сертификата для проверки
    
    Returns:
        True если подпись валидна, False иначе
    """
    try:
        signature_bytes = base64.b64decode(signature_base64)
        try:
            p7 = crypto.load_pkcs7_data(crypto.FILETYPE_ASN1, signature_bytes)
            certs = p7.get0_signers(crypto.X509())
            if not certs:
                return True
            signer_cert = certs[0]
            signer_serial = str(signer_cert.get_serial_number())
            if signer_serial != cert_data.serial_number:
                return False
            if cert_data.valid_to and cert_data.valid_to < datetime.utcnow():
                return False
            return True
        except Exception as e:
            print(f'Ошибка проверки CMS подписи: {e}')
            return False
    except Exception as e:
        print(f'Ошибка при декодировании подписи: {e}')
        return False

@app.get('/auth/nonce', response_model=NonceResponse)
async def get_nonce(db: Session=Depends(get_db)):
    """
    Генерация одноразового nonce для подписи
    
    Nonce имеет TTL 5 минут и может быть использован только один раз
    """
    nonce = generate_nonce()
    expires_at = datetime.utcnow() + timedelta(minutes=5)
    used_nonce = UsedNonce(nonce=nonce, expires_at=expires_at)
    db.add(used_nonce)
    db.commit()
    return NonceResponse(nonce=nonce, expires_at=expires_at)

@app.post('/api/ncalayer/extract-from-cms')
async def extract_from_cms(request: dict):
    """
    Извлечение данных сертификата из CMS подписи
    Используется, когда NCALayer возвращает только подпись без данных
    """
    try:
        cms_signature = request.get('cms_signature')
        if not cms_signature:
            raise HTTPException(status_code=400, detail='Не указана CMS подпись')
        signature_bytes = base64.b64decode(cms_signature)
        p7 = crypto.load_pkcs7_data(crypto.FILETYPE_ASN1, signature_bytes)
        certs = p7.get0_signers(crypto.X509())
        if not certs or len(certs) == 0:
            raise HTTPException(status_code=400, detail='Не найдены сертификаты в CMS подписи')
        cert = certs[0]
        subject = cert.get_subject()
        issuer = cert.get_issuer()
        common_name = ''
        email = ''
        organization = ''
        iin = ''
        for attr in subject.get_components():
            attr_name = attr[0].decode('utf-8') if isinstance(attr[0], bytes) else str(attr[0])
            attr_value = attr[1].decode('utf-8') if isinstance(attr[1], bytes) else str(attr[1])
            if attr_name == 'CN' or attr_name == 'commonName':
                common_name = attr_value
            elif attr_name == 'E' or attr_name == 'emailAddress':
                email = attr_value
            elif attr_name == 'O' or attr_name == 'organizationName':
                organization = attr_value
            elif 'INN' in attr_name.upper() or '1.2.643.100.1' in attr_name or '1.2.398.3.3.1.1' in attr_name:
                iin = attr_value
        if not iin:
            iin_match = re.search('\\d{12}', common_name)
            if iin_match:
                iin = iin_match.group(0)
        serial_number = str(cert.get_serial_number())
        issuer_cn = ''
        for attr in issuer.get_components():
            attr_name = attr[0].decode('utf-8') if isinstance(attr[0], bytes) else str(attr[0])
            attr_value = attr[1].decode('utf-8') if isinstance(attr[1], bytes) else str(attr[1])
            if attr_name == 'CN' or attr_name == 'commonName':
                issuer_cn = attr_value
                break
        valid_from = datetime.strptime(cert.get_notBefore().decode('utf-8'), '%Y%m%d%H%M%SZ')
        valid_to = datetime.strptime(cert.get_notAfter().decode('utf-8'), '%Y%m%d%H%M%SZ')
        return {'success': True, 'data': {'iin': iin, 'full_name': common_name or 'Не указано', 'serial_number': serial_number, 'issuer': issuer_cn or 'Неизвестный УЦ', 'valid_from': valid_from.isoformat(), 'valid_to': valid_to.isoformat(), 'email': email or None, 'company_name': organization or None}}
    except HTTPException:
        raise
    except Exception as e:
        print(f'Ошибка извлечения данных из CMS: {e}')
        raise HTTPException(status_code=500, detail=f'Ошибка при извлечении данных из CMS подписи: {str(e)}')

@app.post('/auth/verify', response_model=AuthResponse)
async def verify_signature(request: VerifyRequest, db: Session=Depends(get_db)):
    """
    Верификация XML подписи и авторизация/регистрация пользователя
    
    Процесс:
    1. Извлекаем nonce из подписанного XML
    2. Проверяем, что nonce существует и не использован
    3. Извлекаем данные сертификата из XML подписи
    4. Проверяем валидность подписи
    5. Проверяем срок действия сертификата
    6. Если пользователь существует - вход, иначе - регистрация
    """
    try:
        try:
            root = etree.fromstring(request.signedXml.encode('utf-8'))
            nonce = (root.text or '').strip()
            if not nonce:
                all_text = ''.join(root.itertext()).strip()
                if all_text:
                    for child in root:
                        if child.tag.endswith('Signature'):
                            continue
                    nonce = all_text.split()[0] if all_text.split() else ''
            if not nonce:
                raise HTTPException(status_code=400, detail='Не найден nonce в подписанном XML')
            extracted_nonce = nonce
        except HTTPException:
            raise
        except etree.XMLSyntaxError as e:
            raise HTTPException(status_code=400, detail=f'Ошибка парсинга XML: {str(e)}')
        except Exception as e:
            print(f'Ошибка при извлечении nonce: {e}')
            import traceback
            traceback.print_exc()
            raise HTTPException(status_code=400, detail=f'Ошибка при извлечении nonce: {str(e)}')
        used_nonce = db.query(UsedNonce).filter(UsedNonce.nonce == extracted_nonce).first()
        if not used_nonce:
            raise HTTPException(status_code=400, detail='Неверный nonce. Запросите новый nonce через GET /auth/nonce')
        if used_nonce.used_at:
            raise HTTPException(status_code=400, detail='Nonce уже использован. Запросите новый nonce')
        if used_nonce.expires_at < datetime.utcnow():
            raise HTTPException(status_code=400, detail='Nonce истек. Запросите новый nonce')
        cert_data = None
        try:
            x509_cert_elem = root.find('.//{http://www.w3.org/2000/09/xmldsig#}X509Certificate')
            if x509_cert_elem is not None:
                cert_pem = x509_cert_elem.text
                cert_bytes = base64.b64decode(cert_pem)
                cert = x509.load_der_x509_certificate(cert_bytes, default_backend())
                subject = cert.subject
                issuer = cert.issuer
                common_name = ''
                email = ''
                organization = ''
                iin = ''
                bin_value = ''
                for attr in subject:
                    oid_str = str(attr.oid)
                    attr_name = attr.oid._name if hasattr(attr.oid, '_name') else str(attr.oid)
                    attr_value = attr.value
                    if attr_name == 'commonName' or attr_name == 'CN':
                        common_name = attr_value
                    elif attr_name == 'emailAddress' or attr_name == 'E':
                        email = attr_value
                    elif attr_name == 'organizationName' or attr_name == 'O':
                        organization = attr_value
                    elif '1.2.643.100.1' in oid_str or '1.2.398.3.3.1.1' in oid_str:
                        if organization:
                            bin_value = attr_value
                        else:
                            iin = attr_value
                    elif 'INN' in oid_str.upper() or 'BIN' in oid_str.upper():
                        if organization:
                            bin_value = attr_value
                        else:
                            iin = attr_value
                if not iin and (not bin_value):
                    subject_str = str(subject)
                    inn_match = re.search('\\d{12}', subject_str)
                    if inn_match:
                        if organization:
                            bin_value = inn_match.group(0)
                        else:
                            iin = inn_match.group(0)
                    else:
                        inn_match = re.search('\\d{12}', common_name)
                        if inn_match:
                            if organization:
                                bin_value = inn_match.group(0)
                            else:
                                iin = inn_match.group(0)
                issuer_cn = ''
                for attr in issuer:
                    attr_name = attr.oid._name if hasattr(attr.oid, '_name') else str(attr.oid)
                    if attr_name == 'commonName' or attr_name == 'CN':
                        issuer_cn = attr.value
                        break
                cert_data = CertificateData(iin=iin, full_name=common_name or 'Не указано', serial_number=str(cert.serial_number), issuer=issuer_cn or 'Неизвестный УЦ', valid_from=cert.not_valid_before, valid_to=cert.not_valid_after, email=email or None, company_name=organization or None)
        except Exception as e:
            print(f'Ошибка извлечения данных сертификата из XML: {e}')
            raise HTTPException(status_code=400, detail='Не удалось извлечь данные сертификата из XML подписи')
        if not cert_data or (not cert_data.iin and (not bin_value)):
            raise HTTPException(status_code=400, detail='Не удалось извлечь ИИН или БИН из сертификата')
        is_signature_valid = verify_xml_signature(request.signedXml, extracted_nonce, cert_data)
        if not is_signature_valid:
            identifier = iin if iin else bin_value if bin_value else 'неизвестно'
            print(f'Ошибка проверки XML подписи для ИИН/БИН: {identifier}')
            raise HTTPException(status_code=400, detail='Неверная подпись. Проверьте сертификат и попробуйте снова')
        if cert_data.valid_to and cert_data.valid_to < datetime.utcnow():
            raise HTTPException(status_code=400, detail='Сертификат истек. Используйте действующий сертификат')
        search_iin = iin if iin else None
        search_bin = bin_value if bin_value else None
        user = None
        if search_iin:
            user = db.query(User).filter(User.iin == search_iin).first()
        elif search_bin:
            user = db.query(User).filter(User.bin == search_bin).first()
        is_new_user = False
        if not user:
            is_new_user = True
            user = User(iin=search_iin or '', bin=search_bin or None, full_name=cert_data.full_name, email=cert_data.email, company_name=cert_data.company_name, cert_serial=cert_data.serial_number, cert_issuer=cert_data.issuer, cert_valid_from=cert_data.valid_from, cert_valid_to=cert_data.valid_to, last_login=datetime.utcnow())
            db.add(user)
            db.commit()
            db.refresh(user)
            message = f'Пользователь {cert_data.full_name} успешно зарегистрирован'
        else:
            user.full_name = cert_data.full_name
            user.email = cert_data.email or user.email
            user.company_name = cert_data.company_name or user.company_name
            if search_bin and (not user.bin):
                user.bin = search_bin
            user.cert_serial = cert_data.serial_number
            user.cert_issuer = cert_data.issuer
            user.cert_valid_from = cert_data.valid_from
            user.cert_valid_to = cert_data.valid_to
            user.last_login = datetime.utcnow()
            db.commit()
            db.refresh(user)
            message = f'Добро пожаловать, {cert_data.full_name}!'
        used_nonce.used_at = datetime.utcnow()
        db.commit()
        return AuthResponse(success=True, message=message, user=UserResponse.model_validate(user), is_new_user=is_new_user)
    except HTTPException:
        raise
    except Exception as e:
        print(f'Ошибка при верификации: {e}')
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f'Внутренняя ошибка сервера: {str(e)}')

def parse_x_user_id(x_user_id: Optional[str]=Header(None, alias='X-User-Id')) -> int:
    """Только разбор X-User-Id без round-trip в БД (для узких read-only эндпоинтов)."""
    if not x_user_id:
        raise HTTPException(status_code=401, detail='Пользователь не авторизован')
    try:
        return int(x_user_id)
    except ValueError:
        raise HTTPException(status_code=400, detail='Неверный формат ID пользователя')

def get_current_user_id(x_user_id: Optional[str]=Header(None, alias='X-User-Id'), db: Session=Depends(get_db)) -> int:
    """Получение ID текущего пользователя из заголовка запроса"""
    if not x_user_id:
        raise HTTPException(status_code=401, detail='Пользователь не авторизован')
    try:
        user_id = int(x_user_id)
    except ValueError:
        raise HTTPException(status_code=400, detail='Неверный формат ID пользователя')
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail='Пользователь не найден')
    return user.id

@app.put('/api/users/{user_id}/bin')
async def update_user_bin(user_id: int, bin_data: dict, db: Session=Depends(get_db), current_user_id: int=Depends(get_current_user_id)):
    """Обновление БИН пользователя"""
    if user_id != current_user_id:
        raise HTTPException(status_code=403, detail='Можно обновлять только свои данные')
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail='Пользователь не найден')
    bin_value = bin_data.get('bin')
    if bin_value and len(bin_value) == 12 and bin_value.isdigit():
        user.bin = bin_value
        db.commit()
        db.refresh(user)
        return {'success': True, 'message': 'БИН успешно обновлен', 'bin': user.bin}
    else:
        raise HTTPException(status_code=400, detail='БИН должен содержать 12 цифр')

@app.put('/api/users/{user_id}/payment-details', response_model=UserResponse)
async def update_payment_details(user_id: int, payment_details: PaymentDetailsUpdate, db: Session=Depends(get_db), current_user_id: int=Depends(get_current_user_id)):
    """Обновление платёжных реквизитов пользователя"""
    if user_id != current_user_id:
        raise HTTPException(status_code=403, detail='Можно обновлять только свои реквизиты')
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail='Пользователь не найден')
    try:
        bin_to_check = payment_details.iin if hasattr(payment_details, 'iin') and payment_details.iin else user.bin if user.bin else user.iin
        if bin_to_check:
            bin_norm = str(bin_to_check).strip()
            iin_norm = str(user.iin).strip() if user.iin else ''
            has_company_bin = bool(user.bin and str(user.bin).strip())
            skip_egov_for_individual_iin = not has_company_bin and iin_norm and (bin_norm == iin_norm)
            if not skip_egov_for_individual_iin:
                from egov_api import get_company_by_bin, verify_company_data
                company_data = get_company_by_bin(bin_to_check, db)
                if not company_data:
                    raise HTTPException(status_code=400, detail='Компания с указанным БИН не найдена в реестре data.egov.kz. Проверьте БИН (12 цифр) для юрлица или ИП. Если вы зарегистрированы как физлицо по ИИН, убедитесь, что в профиле не указан чужой БИН.')
                status = company_data.get('statusru', '').lower()
                if 'ликвидирован' in status or 'прекращен' in status:
                    raise HTTPException(status_code=400, detail=f"Компания с БИН {bin_to_check} имеет статус '{company_data.get('statusru')}'. Невозможно сохранить реквизиты.")
        user.recipient_name = payment_details.recipient_name
        user.bank_name = payment_details.bank_name
        user.bank_bik = payment_details.bank_bik
        user.bank_account = payment_details.bank_account
        if payment_details.bank_corr_account is not None:
            user.bank_corr_account = payment_details.bank_corr_account
        if payment_details.kpp is not None:
            user.kpp = payment_details.kpp
        if payment_details.payment_currency is not None:
            user.payment_currency = payment_details.payment_currency
        if payment_details.address is not None:
            user.address = payment_details.address
        if payment_details.director_name is not None:
            user.director_name = payment_details.director_name
        if payment_details.accountant_name is not None:
            user.accountant_name = payment_details.accountant_name
        db.commit()
        db.refresh(user)
        return user
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f'Ошибка при обновлении реквизитов: {str(e)}')

@app.delete('/api/users/{user_id}/payment-details')
async def clear_payment_details(user_id: int, db: Session=Depends(get_db), current_user_id: int=Depends(get_current_user_id)):
    """Очистка платёжных реквизитов пользователя"""
    if user_id != current_user_id:
        raise HTTPException(status_code=403, detail='Можно очищать только свои реквизиты')
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail='Пользователь не найден')
    try:
        user.recipient_name = None
        user.bank_name = None
        user.bank_bik = None
        user.bank_account = None
        user.bank_corr_account = None
        user.kpp = None
        user.payment_currency = 'KZT'
        user.address = None
        user.director_name = None
        user.accountant_name = None
        db.commit()
        db.refresh(user)
        return {'success': True, 'message': 'Платёжные реквизиты очищены'}
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f'Ошибка при очистке реквизитов: {str(e)}')

@app.get('/api/users/{user_id}/payment-details')
async def get_payment_details(user_id: int, db: Session=Depends(get_db), current_user_id: int=Depends(get_current_user_id)):
    """Получить платёжные реквизиты пользователя"""
    if user_id != current_user_id:
        raise HTTPException(status_code=403, detail='Можно просматривать только свои реквизиты')
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail='Пользователь не найден')
    return {'recipient_name': user.recipient_name, 'bank_name': user.bank_name, 'bank_bik': user.bank_bik, 'bank_account': user.bank_account, 'bank_corr_account': user.bank_corr_account, 'kpp': user.kpp, 'payment_currency': user.payment_currency or 'KZT', 'address': user.address, 'director_name': user.director_name, 'accountant_name': user.accountant_name, 'has_all_required': bool(user.recipient_name and user.bank_name and user.bank_bik and user.bank_account)}

def calculate_distance_km(from_city: str, to_city: str, from_address: Optional[str]=None, to_address: Optional[str]=None) -> Optional[float]:
    """Рассчитывает расстояние между городами/адресами через Google Maps Distance Matrix API"""
    try:
        google_maps_api_key = os.getenv('GOOGLE_MAPS_API_KEY')
        if not google_maps_api_key:
            print('Предупреждение: GOOGLE_MAPS_API_KEY не установлен, расстояние не будет рассчитано')
            return None
        gmaps = googlemaps.Client(key=google_maps_api_key)
        origin = f'{from_address}, {from_city}' if from_address else from_city
        destination = f'{to_address}, {to_city}' if to_address else to_city
        if 'Казахстан' not in origin and 'Kazakhstan' not in origin:
            origin += ', Казахстан'
        if 'Казахстан' not in destination and 'Kazakhstan' not in destination:
            destination += ', Казахстан'
        result = gmaps.distance_matrix(origins=[origin], destinations=[destination], mode='driving', language='ru', units='metric')
        if result['status'] == 'OK' and len(result['rows']) > 0:
            element = result['rows'][0]['elements'][0]
            if element['status'] == 'OK':
                distance_meters = element['distance']['value']
                distance_km = distance_meters / 1000.0
                print(f'Расстояние рассчитано: {origin} → {destination} = {distance_km:.2f} км')
                return round(distance_km, 2)
            else:
                print(f"Ошибка расчета расстояния: {element.get('status', 'UNKNOWN')}")
                return None
        else:
            print(f"Ошибка Google Maps API: {result.get('status', 'UNKNOWN')}")
            return None
    except Exception as e:
        print(f'Ошибка при расчете расстояния через Google Maps: {e}')
        return None

def _bg_update_request_distance(request_id: int, from_city: str, to_city: str, from_address: Optional[str], to_address: Optional[str]) -> None:
    """Google Distance Matrix вне HTTP-пути создания заявки (иначе +1–5 с на каждый POST)."""
    db = SessionLocal()
    try:
        req = db.query(Request).filter(Request.id == request_id).first()
        if not req:
            return
        t0 = time.perf_counter()
        km = calculate_distance_km(from_city, to_city, from_address, to_address)
        if os.getenv('DEBUG_DB_TIMING'):
            print(f'[bg] distance_km Google ms={(time.perf_counter() - t0) * 1000:.1f} request_id={request_id}')
        if km is not None:
            req.distance_km = km
            db.commit()
    except Exception as e:
        print(f'Фоновое обновление distance_km для заявки {request_id}: {e}')
        db.rollback()
    finally:
        db.close()

def get_ai_chat_response(user_message: str, user_context: Optional[dict]=None) -> str:
    """Получает ответ от AI чат-бота через Groq."""
    try:
        groq_api_key = os.getenv('GROQ_API_KEY')
        if groq_api_key:
            client = Groq(api_key=groq_api_key)
            system_prompt = 'Ты - полезный AI-ассистент для платформы грузоперевозок CargoAitu в Казахстане.\nТы помогаешь пользователям с вопросами о:\n- Создании заявок на перевозку\n- Подаче предложений (ставок)\n- Работе с контрактами и документами\n- Электронной цифровой подписи (ЭЦП)\n- Общих вопросах о платформе\n\nОтвечай кратко, по делу, на русском языке. Структурируй текст: между абзацами и шагами оставляй пустую строку; пошаговые инструкции оформляй нумерованным списком (1. 2. 3.) с переносом строки после каждого пункта. Не пиши всё одним сплошным абзацем. Если не знаешь ответа, предложи обратиться в поддержку.'
            messages = [{'role': 'system', 'content': system_prompt}]
            if user_context:
                context_text = f'Контекст пользователя: {json.dumps(user_context, ensure_ascii=False)}'
                messages.append({'role': 'system', 'content': context_text})
            messages.append({'role': 'user', 'content': user_message})
            response = client.chat.completions.create(
                model=os.getenv('GROQ_MODEL', 'llama-3.1-8b-instant'),
                messages=messages,
                max_tokens=500,
                temperature=0.7,
            )
            return response.choices[0].message.content
        return 'Извините, AI чат-бот временно недоступен. Пожалуйста, обратитесь в поддержку.'
    except Exception as e:
        print(f'Ошибка при получении ответа от AI: {e}')
        return 'Извините, произошла ошибка при обработке вашего запроса. Попробуйте позже.'

@app.post('/api/requests', response_model=RequestResponse)
async def create_request(request_data: RequestCreate, background_tasks: BackgroundTasks, db: Session=Depends(get_db), user_id: int=Depends(get_current_user_id)):
    """Создание новой заявки на перевозку"""
    try:
        t_start = time.perf_counter()
        user = db.query(User).filter(User.id == user_id).first()
        t_after_user = time.perf_counter()
        if not user:
            raise HTTPException(status_code=404, detail='Пользователь не найден')
        distance_km = None
        now = datetime.utcnow()
        bidding_started_at = request_data.bidding_started_at if request_data.bidding_started_at else now
        bidding_started_at = naive_utc(bidding_started_at)
        bidding_ends_at = naive_utc(request_data.bidding_ends_at) if request_data.bidding_ends_at else None
        if not bidding_ends_at:
            hours = 2 if request_data.is_express else 24
            bidding_ends_at = bidding_started_at + timedelta(hours=hours)
        validate_auction_schedule(now, bidding_started_at, bidding_ends_at)
        auction_type = normalize_auction_type(request_data.auction_type)
        new_request = Request(customer_id=user_id, title=request_data.title, description=request_data.description, from_city=request_data.from_city, to_city=request_data.to_city, from_address=request_data.from_address, to_address=request_data.to_address, distance_km=distance_km, cargo_type=request_data.cargo_type, cargo_weight=request_data.cargo_weight, cargo_volume=request_data.cargo_volume, body_type=request_data.body_type, loading_date=naive_utc(request_data.loading_date), delivery_date=naive_utc(request_data.delivery_date), max_price=request_data.max_price, min_price=None, is_express=request_data.is_express, conditions=request_data.conditions, auction_type=auction_type, bidding_started_at=bidding_started_at, bidding_ends_at=bidding_ends_at, revision=0, status=RequestStatus.ACTIVE.value)
        db.add(new_request)
        t_before_commit = time.perf_counter()
        db.commit()
        t_after_commit = time.perf_counter()
        if request_data.from_city and request_data.to_city:
            background_tasks.add_task(_bg_update_request_distance, new_request.id, request_data.from_city, request_data.to_city, request_data.from_address, request_data.to_address)
        if os.getenv('DEBUG_DB_TIMING'):
            print(f'[create_request] user lookup ms={(t_after_user - t_start) * 1000:.1f} before_commit ms={(t_before_commit - t_after_user) * 1000:.1f} commit ms={(t_after_commit - t_before_commit) * 1000:.1f} total ms={(t_after_commit - t_start) * 1000:.1f} id={new_request.id}')
        response = RequestResponse.model_validate(new_request)
        enrich_request_response(response, new_request)
        response.customer_name = user.full_name
        response.bids_count = 0
        response.user_has_bid = False
        return response
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f'Ошибка при создании заявки: {str(e)}')

@app.put('/api/requests/{request_id}', response_model=RequestResponse)
async def update_request(request_id: int, request_data: RequestCreate, db: Session=Depends(get_db), user_id: int=Depends(get_current_user_id)):
    """Обновление заявки"""
    try:
        request = db.query(Request).filter(Request.id == request_id).first()
        if not request:
            raise HTTPException(status_code=404, detail='Заявка не найдена')
        if request.customer_id != user_id:
            raise HTTPException(status_code=403, detail='Только заказчик может редактировать свою заявку')
        bids_count = db.query(Bid).filter(Bid.request_id == request_id).count()
        critical_fields = ['from_city', 'to_city', 'from_address', 'to_address', 'cargo_type', 'cargo_weight', 'cargo_volume', 'body_type', 'loading_date', 'delivery_date', 'max_price', 'min_price', 'auction_type', 'bidding_started_at', 'bidding_ends_at']
        if bids_count > 0:
            if request_data.from_city != request.from_city or request_data.to_city != request.to_city or request_data.from_address != request.from_address or (request_data.to_address != request.to_address) or (request_data.cargo_type != request.cargo_type) or (request_data.cargo_weight != request.cargo_weight) or (request_data.cargo_volume != request.cargo_volume) or (request_data.body_type != request.body_type) or (request_data.loading_date != request.loading_date) or (request_data.delivery_date != request.delivery_date) or (request_data.max_price != request.max_price) or (request_data.min_price != request.min_price) or (request_data.auction_type != request.auction_type) or (request_data.bidding_started_at != request.bidding_started_at) or (request_data.bidding_ends_at != request.bidding_ends_at):
                raise HTTPException(status_code=400, detail='После первой ставки нельзя изменять маршрут, параметры груза, даты, цены и время аукциона')
        if request_data.title:
            request.title = request_data.title
        if request_data.description is not None:
            request.description = request_data.description
        if request_data.conditions is not None:
            request.conditions = request_data.conditions
        if bids_count == 0:
            request.from_city = request_data.from_city
            request.to_city = request_data.to_city
            request.from_address = request_data.from_address
            request.to_address = request_data.to_address
            request.cargo_type = request_data.cargo_type
            request.cargo_weight = request_data.cargo_weight
            request.cargo_volume = request_data.cargo_volume
            request.body_type = request_data.body_type
            request.loading_date = naive_utc(request_data.loading_date)
            request.delivery_date = naive_utc(request_data.delivery_date)
            request.max_price = request_data.max_price
            request.min_price = None
            request.is_express = request_data.is_express
            request.auction_type = normalize_auction_type(request_data.auction_type)
            if request_data.bidding_started_at:
                request.bidding_started_at = naive_utc(request_data.bidding_started_at)
            if request_data.bidding_ends_at:
                request.bidding_ends_at = naive_utc(request_data.bidding_ends_at)
            now_u = datetime.utcnow()
            apply_request_bidding_defaults(request, now=now_u)
            if request.bidding_started_at is not None:
                request.bidding_started_at = naive_utc(request.bidding_started_at)
            if request.bidding_ends_at is not None:
                request.bidding_ends_at = naive_utc(request.bidding_ends_at)
            validate_auction_schedule(now_u, request.bidding_started_at, request.bidding_ends_at)
        request.revision += 1
        request.updated_at = datetime.utcnow()
        if bids_count == 0 and request_data.from_city and request_data.to_city:
            try:
                distance_km = calculate_distance_km(from_city=request_data.from_city, to_city=request_data.to_city, from_address=request_data.from_address, to_address=request_data.to_address)
                request.distance_km = distance_km
            except Exception as e:
                print(f'Ошибка расчета расстояния: {e}')
        db.commit()
        db.refresh(request)
        response = RequestResponse.model_validate(request)
        enrich_request_response(response, request)
        user = db.query(User).filter(User.id == user_id).first()
        if user:
            response.customer_name = user.full_name
        bids = db.query(Bid).filter(Bid.request_id == request_id, or_(Bid.is_active == True, Bid.is_selected == True)).all()
        response.bids_count = len(bids)
        return response
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f'Ошибка при обновлении заявки: {str(e)}')

@app.get('/api/requests', response_model=List[RequestResponse])
def get_requests(status: Optional[str]=None, skip: int=0, limit: int=100, db: Session=Depends(get_db), x_user_id: Optional[str]=Header(None, alias='X-User-Id')):
    """Получение списка заявок"""
    try:
        query = db.query(Request).options(joinedload(Request.customer))
        if status:
            query = query.filter(Request.status == status)
        requests = query.order_by(Request.created_at.desc()).offset(skip).limit(limit).all()
        req_ids = [r.id for r in requests]
        bids_count_by_request: dict = {}
        if req_ids:
            rows = db.query(Bid.request_id, func.count(Bid.id)).filter(Bid.request_id.in_(req_ids), or_(Bid.is_active == True, Bid.is_selected == True)).group_by(Bid.request_id).all()
            bids_count_by_request = {rid: int(cnt) for rid, cnt in rows}
        user_bid_request_ids = set()
        current_user_id = None
        if x_user_id and req_ids:
            try:
                user_id_int = int(x_user_id)
                current_user_id = user_id_int
                user_bids = db.query(Bid.request_id).filter(Bid.carrier_id == user_id_int, Bid.request_id.in_(req_ids)).distinct().all()
                user_bid_request_ids = {bid[0] for bid in user_bids}
            except (ValueError, TypeError):
                pass
        result = []
        for req in requests:
            try:
                response = RequestResponse.model_validate(req)
                response.customer_name = req.customer.full_name if req.customer else None
                response.bids_count = bids_count_by_request.get(req.id, 0)
                response.user_has_bid = req.id in user_bid_request_ids
                enrich_request_response(response, req)
                # Скрываем конфиденциальные документы от не-участников
                sanitize_request_response_for_non_participant(response, current_user_id, req)
                result.append(response)
            except Exception as e:
                print(f'Ошибка при валидации заявки {req.id}: {str(e)}')
                continue
        return result
    except Exception as e:
        print(f'Ошибка при получении заявок: {str(e)}')
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f'Ошибка при получении заявок: {str(e)}')

@app.get('/api/requests/{request_id}', response_model=RequestResponseWithBids)
def get_request(request_id: int, include_bids: bool=False, db: Session=Depends(get_db), x_user_id: Optional[str]=Header(None, alias='X-User-Id')):
    """Получение конкретной заявки. include_bids=true — сразу список ставок (один round-trip вместо двух)."""
    request = db.query(Request).options(joinedload(Request.customer), joinedload(Request.selected_carrier), joinedload(Request.assigned_driver), joinedload(Request.assigned_vehicle)).filter(Request.id == request_id).first()
    if not request:
        raise HTTPException(status_code=404, detail='Заявка не найдена')
    response = RequestResponseWithBids.model_validate(request)
    enrich_request_response(response, request)
    response.customer_name = request.customer.full_name if request.customer else None
    sc = request.selected_carrier
    if sc:
        response.selected_carrier_company_name = sc.company_name
        response.selected_carrier_full_name = sc.full_name
        response.selected_carrier_phone = sc.phone
        response.selected_carrier_iin = sc.iin
    if include_bids:
        bids = db.query(Bid).options(joinedload(Bid.carrier)).filter(Bid.request_id == request_id, or_(Bid.is_active == True, Bid.is_selected == True)).order_by(Bid.price.asc()).all()
        bid_list = []
        for bid in bids:
            br = BidResponse.model_validate(bid)
            if bid.carrier:
                br.carrier_name = bid.carrier.full_name
                br.carrier_company = bid.carrier.company_name
            bid_list.append(br)
        response.bids = bid_list
        response.bids_count = len(bid_list)
    else:
        response.bids_count = db.query(func.count(Bid.id)).filter(Bid.request_id == request_id, or_(Bid.is_active == True, Bid.is_selected == True)).scalar() or 0
        response.bids = []
    driver = request.assigned_driver
    if driver:
        response.assigned_driver_name = driver.full_name
        response.assigned_driver_phone = driver.phone
        response.assigned_driver_birth_date = driver.birth_date
    vehicle = request.assigned_vehicle
    if vehicle:
        vehicle_parts = []
        if vehicle.tractor_brand and vehicle.tractor_license_plate:
            vehicle_parts.append(f'{vehicle.tractor_brand} {vehicle.tractor_license_plate}')
        if vehicle.trailer_brand and vehicle.trailer_license_plate:
            vehicle_parts.append(f'{vehicle.trailer_brand} {vehicle.trailer_license_plate}')
        response.assigned_vehicle_info = ', '.join(vehicle_parts) if vehicle_parts else f'ID: {vehicle.id}'
        response.assigned_vehicle_model = vehicle.tractor_brand or vehicle.trailer_brand or None
        stored_bt = vehicle.cargo_body_type or vehicle.body_type
        response.assigned_vehicle_type = vehicle_body_display_label(stored_bt) or vehicle_composition_display_label(resolve_composition_code(vehicle))

    # Скрываем конфиденциальные документы от не-участников
    current_user_id = None
    if x_user_id:
        try:
            current_user_id = int(x_user_id)
        except (ValueError, TypeError):
            pass
    sanitize_request_response_for_non_participant(response, current_user_id, request)

    return response

@app.get('/api/requests/{request_id}/generate-document')
async def generate_request_document(request_id: int, db: Session=Depends(get_db), user_id: int=Depends(get_current_user_id)):
    """Генерация документа заявки на перевозку"""
    try:
        request = db.query(Request).filter(Request.id == request_id).first()
        if not request:
            raise HTTPException(status_code=404, detail='Заявка не найдена')
        if request.customer_id != user_id and (not request.selected_carrier_id or request.selected_carrier_id != user_id):
            raise HTTPException(status_code=403, detail='Нет доступа к заявке')
        customer = db.query(User).filter(User.id == request.customer_id).first()
        if not customer:
            raise HTTPException(status_code=404, detail='Заказчик не найден')
        carrier = None
        if request.selected_carrier_id:
            carrier = db.query(User).filter(User.id == request.selected_carrier_id).first()
        driver = None
        if request.assigned_driver_id:
            driver = db.query(Driver).filter(Driver.id == request.assigned_driver_id).first()
        vehicle = None
        if request.assigned_vehicle_id:
            vehicle = db.query(Vehicle).filter(Vehicle.id == request.assigned_vehicle_id).first()
        selected_bid = None
        if request.selected_bid_id:
            selected_bid = db.query(Bid).filter(Bid.id == request.selected_bid_id).first()
        months_ru = {'January': 'января', 'February': 'февраля', 'March': 'марта', 'April': 'апреля', 'May': 'мая', 'June': 'июня', 'July': 'июля', 'August': 'августа', 'September': 'сентября', 'October': 'октября', 'November': 'ноября', 'December': 'декабря'}

        def format_date_ru(dt):
            if not dt:
                return None
            date_str = dt.strftime('%d.%m.%Y')
            return date_str

        def format_datetime_ru(dt):
            if not dt:
                return None
            date_str = dt.strftime('%d.%m.%Y, %H:%M')
            return date_str
        request_number = str(request.id)
        request_date = format_date_ru(request.created_at) if request.created_at else format_date_ru(datetime.utcnow())
        template_data = {'request_number': request_number, 'request_date': request_date, 'customer_company': customer.company_name or customer.full_name or 'Не указан', 'customer_contact': customer.full_name or '', 'customer_phone': customer.phone or '', 'customer_accounting_phone': '', 'customer_accounting_email': '', 'customer_inn': customer.iin or '', 'customer_kpp': '', 'carrier_company': carrier.company_name or carrier.full_name if carrier else '', 'carrier_contact': carrier.full_name if carrier else '', 'carrier_phone': carrier.phone if carrier else '', 'carrier_accounting_phone': '', 'carrier_accounting_email': '', 'carrier_inn': carrier.iin if carrier else '', 'carrier_kpp': '', 'loading_date': format_date_ru(request.loading_date) if request.loading_date else '', 'loading_time': request.loading_date.strftime('%H:%M') if request.loading_date else '', 'loading_address': request.from_address or request.from_city or 'Не указан', 'loading_contact': '', 'loading_phone': '', 'loading_info': '', 'delivery_date': format_date_ru(request.delivery_date) if request.delivery_date else '', 'delivery_time': request.delivery_date.strftime('%H:%M') if request.delivery_date else '', 'delivery_address': request.to_address or request.to_city or 'Не указан', 'delivery_contact': '', 'delivery_phone': '', 'delivery_info': '', 'cargo_name': request.cargo_type or '', 'cargo_weight': f'{request.cargo_weight:.1f}' if request.cargo_weight else '', 'cargo_volume': f'{request.cargo_volume:.1f}' if request.cargo_volume else '', 'body_type': request.body_type or '', 'loading_type': '', 'cargo_requirements': '', 'price': f'{selected_bid.price:,.0f}'.replace(',', ' ') if selected_bid and selected_bid.price else f'{request.max_price:,.0f}'.replace(',', ' ') if request.max_price else '', 'payment_terms': '', 'driver_name': driver.full_name if driver else '', 'driver_phone': driver.phone if driver else '', 'driver_passport': f"{driver.passport_series or ''} {driver.passport_number or ''}".strip() if driver else '', 'driver_passport_issued': driver.passport_issued_by if driver and driver.passport_issued_by else '', 'driver_birth_date': format_date_ru(driver.birth_date) if driver and driver.birth_date else '', 'vehicle_info': ''}
        if vehicle:
            vehicle_parts = []
            if vehicle.tractor_brand and vehicle.tractor_license_plate:
                vehicle_parts.append(f'Тягач {vehicle.tractor_brand} {vehicle.tractor_license_plate}')
            if vehicle.trailer_brand and vehicle.trailer_license_plate:
                vehicle_parts.append(f'{vehicle.trailer_brand} {vehicle.trailer_license_plate}')
            bt_disp = vehicle_body_display_label(vehicle.cargo_body_type or vehicle.body_type)
            if bt_disp:
                vehicle_parts.append(f', {bt_disp}')
            template_data['vehicle_info'] = ' '.join(vehicle_parts) if vehicle_parts else ''
        else:
            template_data['vehicle_info'] = ''
        months_ru_long = ('', 'января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря')

        def _req_format_date_ru_long(dt):
            if not dt:
                return ''
            return f'«{dt.day}» {months_ru_long[dt.month]} {dt.year} г.'
        loading_date_long = _req_format_date_ru_long(request.loading_date) if request.loading_date else ''
        delivery_date_long = _req_format_date_ru_long(request.delivery_date) if request.delivery_date else ''
        contract_for_request = db.query(Contract).filter(Contract.request_id == request.id).order_by(Contract.id.desc()).first()
        contract_frame_date_long = ''
        if contract_for_request:
            contract_frame_date_long = _req_format_date_ru_long(contract_for_request.signed_at or contract_for_request.created_at)
        desc_l = (request.description or '').lower()
        bt_l = (request.body_type or '').lower()
        body_tent = 'тент' in bt_l
        body_isotherm = 'изотерм' in bt_l
        body_reefer = 'реф' in bt_l or 'рефриж' in bt_l
        body_other = bool((request.body_type or '').strip()) and (not (body_tent or body_isotherm or body_reefer))
        cargo_fragile = 'хруп' in desc_l
        cargo_oversized = 'негабар' in desc_l
        cargo_temp = 'температ' in desc_l or body_reefer
        cargo_normal = not (cargo_fragile or cargo_oversized or cargo_temp)
        c_bin = (customer.bin or '').strip() or (customer.iin or '').strip()
        carrier_bin_parts = []
        if carrier:
            if (carrier.bin or '').strip():
                carrier_bin_parts.append(carrier.bin.strip())
            if (carrier.iin or '').strip():
                carrier_bin_parts.append(carrier.iin.strip())
        carrier_bin_iin_val = ' / '.join(carrier_bin_parts) if carrier_bin_parts else ''
        if request.cargo_weight is not None:
            cargo_weight_kg_val = f'{request.cargo_weight * 1000:.0f}'
        else:
            cargo_weight_kg_val = ''
        template_data.update({'platform_name': 'AituCargo', 'contract_frame_number': str(request.id), 'contract_frame_date_long': contract_frame_date_long, 'customer_bin': c_bin, 'carrier_bin_iin': carrier_bin_iin_val, 'customer_email': (customer.email or '').strip(), 'carrier_email': (carrier.email or '').strip() if carrier else '', 'loading_date_long': loading_date_long, 'delivery_date_long': delivery_date_long, 'loading_time_from': template_data.get('loading_time') or '', 'loading_time_to': '________', 'delivery_time_from': template_data.get('delivery_time') or '', 'delivery_time_to': '________', 'cargo_weight_kg': cargo_weight_kg_val, 'cargo_places': '', 'temperature_regime': (request.conditions or '').strip()[:500], 'body_tent': body_tent, 'body_isotherm': body_isotherm, 'body_reefer': body_reefer, 'body_other': body_other, 'body_other_text': (request.body_type or '').strip() if body_other else '', 'cargo_normal': cargo_normal, 'cargo_fragile': cargo_fragile, 'cargo_oversized': cargo_oversized, 'cargo_temp': cargo_temp, 'vat_included': False, 'vat_not_included': True, 'vehicle_type_display': vehicle_composition_display_label(resolve_composition_code(vehicle)) if vehicle else ''})
        backend_dir = Path(__file__).parent
        template_path = Path('templates') / 'request_document.html'
        if not template_path.exists():
            template_path = backend_dir / 'templates' / 'request_document.html'
        if not template_path.exists():
            raise HTTPException(status_code=500, detail='Шаблон документа не найден')
        template = Template(template_path.read_text(encoding='utf-8'))
        html_content = template.render(**template_data)
        try:
            from weasyprint import HTML
            from io import BytesIO
            import os
            if os.path.exists('/opt/homebrew/lib'):
                os.environ['DYLD_LIBRARY_PATH'] = '/opt/homebrew/lib'
            elif os.path.exists('/usr/local/lib'):
                os.environ['DYLD_LIBRARY_PATH'] = '/usr/local/lib'
            pdf_buffer = BytesIO()
            html_doc = HTML(string=html_content, base_url=str(backend_dir))
            html_doc.write_pdf(pdf_buffer)
            pdf_bytes = pdf_buffer.getvalue()
            pdf_buffer.close()
            if not pdf_bytes or len(pdf_bytes) == 0:
                raise Exception('PDF файл пуст или не был создан')
        except ImportError:
            raise HTTPException(status_code=500, detail='Библиотека weasyprint не установлена. Установите: pip install weasyprint')
        except Exception as e:
            import traceback
            error_details = traceback.format_exc()
            print(f'Ошибка генерации PDF: {error_details}')
            raise HTTPException(status_code=500, detail=f'Ошибка генерации PDF: {str(e)}')
        filename_safe = f'request_{request.id}_document.pdf'
        filename_display = f'Заявка_{request.id}_документ.pdf'
        import urllib.parse
        filename_encoded = urllib.parse.quote(filename_display.encode('utf-8'))
        return Response(content=pdf_bytes, media_type='application/pdf', headers={'Content-Disposition': f"""attachment; filename="{filename_safe}"; filename*=UTF-8''{filename_encoded}""", 'Content-Type': 'application/pdf', 'X-Content-Type-Options': 'nosniff'})
    except HTTPException:
        raise
    except Exception as e:
        import traceback
        error_details = traceback.format_exc()
        print(f'Ошибка генерации документа заявки: {error_details}')
        raise HTTPException(status_code=500, detail=f'Ошибка при генерации документа: {str(e)}')

@app.delete('/api/requests/{request_id}')
async def delete_request(request_id: int, db: Session=Depends(get_db), user_id: int=Depends(get_current_user_id)):
    """Удаление заявки (только владелец может удалить)"""
    request = db.query(Request).filter(Request.id == request_id).first()
    if not request:
        raise HTTPException(status_code=404, detail='Заявка не найдена')
    if request.customer_id != user_id:
        raise HTTPException(status_code=403, detail='Недостаточно прав для удаления заявки')
    if request.status != RequestStatus.ACTIVE.value:
        raise HTTPException(status_code=400, detail='Нельзя удалить заявку, которая уже в работе или завершена')
    try:
        db.delete(request)
        db.commit()
        return {'message': 'Заявка удалена'}
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f'Ошибка при удалении заявки: {str(e)}')

@app.post('/api/requests/{request_id}/bids', response_model=BidResponse)
async def create_bid(request_id: int, bid_data: BidCreate, db: Session=Depends(get_db), user_id: int=Depends(get_current_user_id)):
    """Подача предложения от перевозчика на заявку"""
    try:
        request = db.query(Request).filter(Request.id == request_id).first()
        if not request:
            raise HTTPException(status_code=404, detail='Заявка не найдена')
        if request.status != RequestStatus.ACTIVE.value:
            raise HTTPException(status_code=400, detail='Заявка больше не принимает предложения')
        if request.customer_id == user_id:
            raise HTTPException(status_code=400, detail='Заказчик не может подавать предложения на свою заявку')
        partnership = db.query(Partnership).filter((Partnership.company1_id == user_id) & (Partnership.company2_id == request.customer_id) | (Partnership.company1_id == request.customer_id) & (Partnership.company2_id == user_id), Partnership.status == PartnershipStatus.SIGNED.value).first()
        if not partnership:
            raise HTTPException(status_code=403, detail="Для участия в аукционе необходимо заключить договор партнерства с компанией заказчика. Перейдите в раздел 'Организации' для заключения партнерства.")
        now = datetime.utcnow()
        if request.bidding_started_at and now < request.bidding_started_at:
            raise HTTPException(status_code=400, detail=f'Аукцион еще не начался. Начало: {request.bidding_started_at}')
        if request.bidding_ends_at and now > request.bidding_ends_at:
            raise HTTPException(status_code=400, detail='Аукцион уже закрыт')
        validate_bid_price_against_request(request, bid_data.price)
        assert_bid_price_tenge_grid(bid_data.price)
        if request.bidding_ends_at:
            time_remaining = (request.bidding_ends_at - now).total_seconds()
            if 0 < time_remaining <= 300:
                request.bidding_ends_at = now + timedelta(minutes=5)
                request.revision += 1
                print(f'[ANTISNIPING] Аукцион продлен на 5 минут для заявки {request_id}')
        existing_bid = db.query(Bid).filter(Bid.request_id == request_id, Bid.carrier_id == user_id, Bid.is_active == True).first()
        if existing_bid:
            raise HTTPException(status_code=400, detail='Вы уже подали активное предложение на эту заявку. Используйте обновление ставки.')
        new_bid = Bid(request_id=request_id, carrier_id=user_id, price=bid_data.price, price_per_km=bid_data.price_per_km, delivery_time=bid_data.delivery_time, conditions=bid_data.conditions, vehicle_info=bid_data.vehicle_info, is_active=True, revision=0)
        db.add(new_bid)
        try:
            notification = Notification(user_id=request.customer_id, type='new_bid', title='Новая ставка', message=f'Получена новая ставка на заявку: {request.from_city} → {request.to_city}. Цена: {bid_data.price} ₸', request_id=request.id, bid_id=None, is_read=False)
            db.add(notification)
        except Exception as e:
            print(f'Ошибка при создании уведомления о новой ставке: {e}')
        db.commit()
        db.refresh(new_bid)
        if notification:
            notification.bid_id = new_bid.id
            db.commit()
        response = BidResponse.model_validate(new_bid)
        carrier = db.query(User).filter(User.id == user_id).first()
        if carrier:
            response.carrier_name = carrier.full_name
            response.carrier_company = carrier.company_name
        return response
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f'Ошибка при создании предложения: {str(e)}')

@app.get('/api/requests/{request_id}/bids', response_model=List[BidResponse])
def get_bids(request_id: int, db: Session=Depends(get_db)):
    """Получение всех предложений на заявку"""
    request = db.query(Request).filter(Request.id == request_id).first()
    if not request:
        raise HTTPException(status_code=404, detail='Заявка не найдена')
    bids = db.query(Bid).options(joinedload(Bid.carrier)).filter(Bid.request_id == request_id, or_(Bid.is_active == True, Bid.is_selected == True)).order_by(Bid.price.asc()).all()
    result = []
    for bid in bids:
        response = BidResponse.model_validate(bid)
        if bid.carrier:
            response.carrier_name = bid.carrier.full_name
            response.carrier_company = bid.carrier.company_name
        result.append(response)
    return result

@app.put('/api/bids/{bid_id}', response_model=BidResponse)
async def update_bid(bid_id: int, bid_data: BidUpdate, db: Session=Depends(get_db), user_id: int=Depends(get_current_user_id)):
    """Обновление предложения от перевозчика"""
    try:
        bid = db.query(Bid).filter(Bid.id == bid_id).first()
        if not bid:
            raise HTTPException(status_code=404, detail='Предложение не найдено')
        if bid.carrier_id != user_id:
            raise HTTPException(status_code=403, detail='Вы можете обновлять только свои предложения')
        if not bid.is_active:
            raise HTTPException(status_code=400, detail='Нельзя обновить неактивное предложение')
        request = db.query(Request).filter(Request.id == bid.request_id).first()
        if not request:
            raise HTTPException(status_code=404, detail='Заявка не найдена')
        now = datetime.utcnow()
        if request.bidding_started_at and now < request.bidding_started_at:
            raise HTTPException(status_code=400, detail=f'Аукцион еще не начался. Начало: {request.bidding_started_at}')
        if request.bidding_ends_at and now > request.bidding_ends_at:
            raise HTTPException(status_code=400, detail='Аукцион уже закрыт')
        final_price = bid_data.price if bid_data.price is not None else bid.price
        validate_bid_price_against_request(request, final_price)
        assert_bid_price_tenge_grid(final_price)
        if request.bidding_ends_at:
            time_remaining = (request.bidding_ends_at - now).total_seconds()
            if 0 < time_remaining <= 300:
                request.bidding_ends_at = now + timedelta(minutes=5)
                request.revision += 1
                print(f'[ANTISNIPING] Аукцион продлен на 5 минут для заявки {request.id}')
        old_price = bid.price
        if bid_data.price is not None:
            bid.price = bid_data.price
        if bid_data.price_per_km is not None:
            bid.price_per_km = bid_data.price_per_km
        if bid_data.delivery_time is not None:
            bid.delivery_time = bid_data.delivery_time
        if bid_data.conditions is not None:
            bid.conditions = bid_data.conditions
        if bid_data.vehicle_info is not None:
            bid.vehicle_info = bid_data.vehicle_info
        bid.revision += 1
        bid.updated_at = datetime.utcnow()
        try:
            notification = Notification(user_id=request.customer_id, type='bid_updated', title='Обновление ставки', message=f'Ставка обновлена на заявку: {request.from_city} → {request.to_city}. Новая цена: {bid.price} ₸ (было: {old_price} ₸)', request_id=request.id, bid_id=bid.id, is_read=False)
            db.add(notification)
        except Exception as e:
            print(f'Ошибка при создании уведомления об обновлении ставки: {e}')
        try:
            add_request_history(db=db, request_id=request.id, event_type='bid_updated', description=f'Ставка обновлена: {old_price} ₸ → {bid.price} ₸', user_id=user_id, commit=False)
        except Exception as e:
            print(f'Ошибка при добавлении записи в историю: {e}')
        db.commit()
        db.refresh(bid)
        response = BidResponse.model_validate(bid)
        if bid.carrier:
            response.carrier_name = bid.carrier.full_name
            response.carrier_company = bid.carrier.company_name
        return response
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f'Ошибка при обновлении предложения: {str(e)}')

@app.post('/api/requests/{request_id}/select-winner')
async def select_winner(request_id: int, bid_id: int, db: Session=Depends(get_db), user_id: int=Depends(get_current_user_id)):
    """Выбор победителя аукциона (заказчик выбирает перевозчика)"""
    try:
        request = db.query(Request).filter(Request.id == request_id).first()
        if not request:
            raise HTTPException(status_code=404, detail='Заявка не найдена')
        if request.customer_id != user_id:
            raise HTTPException(status_code=403, detail='Только заказчик может выбрать победителя')
        if request.status != RequestStatus.ACTIVE.value:
            raise HTTPException(status_code=400, detail='Заявка больше не активна')
        bid = db.query(Bid).filter(Bid.id == bid_id, Bid.request_id == request_id).first()
        if not bid:
            raise HTTPException(status_code=404, detail='Предложение не найдено')
        db.query(Bid).filter(Bid.request_id == request_id).update({'is_rejected': True, 'is_active': False})
        bid.is_selected = True
        bid.is_rejected = False
        bid.is_active = True
        request.selected_carrier_id = bid.carrier_id
        request.selected_bid_id = bid.id
        request.status = RequestStatus.AWAITING_CARRIER_CONFIRMATION.value
        request.closed_at = datetime.utcnow()
        request.revision += 1
        carrier = db.query(User).filter(User.id == bid.carrier_id).first()
        carrier_name = carrier.company_name if carrier and carrier.company_name else carrier.full_name if carrier else 'Перевозчик'
        try:
            add_request_history(db=db, request_id=request_id, event_type='winner_determined', description=f'Определён победитель: {carrier_name}', user_id=user_id, commit=False)
        except Exception as e:
            print(f'Ошибка при добавлении записи в историю: {e}')
        try:
            notification = Notification(user_id=bid.carrier_id, type='bid_won', title='Вы выиграли заказ!', message=f'Ваше предложение было принято. Заказ: {request.from_city} → {request.to_city}. Цена: {bid.price} ₸', request_id=request.id, bid_id=bid.id, is_read=False)
            db.add(notification)
            print(f'Создано уведомление для пользователя {bid.carrier_id} о заказе {request.id}')
        except Exception as e:
            print(f'Ошибка при создании уведомления: {e}')
        db.commit()
        return {'success': True, 'message': 'Победитель выбран', 'bid_id': bid.id, 'carrier_id': bid.carrier_id}
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f'Ошибка при выборе победителя: {str(e)}')

@app.post('/api/requests/{request_id}/accept')
async def accept_request(request_id: int, db: Session=Depends(get_db), user_id: int=Depends(get_current_user_id)):
    """Подтверждение заявки перевозчиком"""
    try:
        request = db.query(Request).filter(Request.id == request_id).first()
        if not request:
            raise HTTPException(status_code=404, detail='Заявка не найдена')
        if request.selected_carrier_id != user_id:
            raise HTTPException(status_code=403, detail='Только выбранный перевозчик может подтвердить заявку')
        if request.status != RequestStatus.AWAITING_CARRIER_CONFIRMATION.value:
            raise HTTPException(status_code=400, detail='Заявка не ожидает подтверждения')
        request.status = RequestStatus.IN_PROGRESS.value
        request.revision += 1
        try:
            add_request_history(db=db, request_id=request_id, event_type='carrier_accepted', description='Перевозчик подтвердил заявку', user_id=user_id, commit=False)
        except Exception as e:
            print(f'Ошибка при добавлении записи в историю: {e}')
        try:
            carrier = db.query(User).filter(User.id == user_id).first()
            carrier_name = carrier.company_name if carrier and carrier.company_name else carrier.full_name if carrier else 'Перевозчик'
            notification = Notification(user_id=request.customer_id, type='carrier_accepted', title='Перевозчик подтвердил заявку', message=f'Перевозчик {carrier_name} подтвердил заявку: {request.from_city} → {request.to_city}', request_id=request.id, bid_id=request.selected_bid_id, is_read=False)
            db.add(notification)
        except Exception as e:
            print(f'Ошибка при создании уведомления: {e}')
        db.commit()
        return {'success': True, 'message': 'Заявка подтверждена', 'request_id': request_id, 'status': request.status}
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f'Ошибка при подтверждении заявки: {str(e)}')

@app.post('/api/requests/{request_id}/decline')
async def decline_request(request_id: int, db: Session=Depends(get_db), user_id: int=Depends(get_current_user_id)):
    """Отказ перевозчика от заявки"""
    try:
        request = db.query(Request).filter(Request.id == request_id).first()
        if not request:
            raise HTTPException(status_code=404, detail='Заявка не найдена')
        if request.selected_carrier_id != user_id:
            raise HTTPException(status_code=403, detail='Только выбранный перевозчик может отказаться от заявки')
        if request.status != RequestStatus.AWAITING_CARRIER_CONFIRMATION.value:
            raise HTTPException(status_code=400, detail='Заявка не ожидает подтверждения')
        bid = db.query(Bid).filter(Bid.id == request.selected_bid_id).first()
        if bid:
            bid.is_selected = False
            bid.is_rejected = True
            bid.is_active = False
        request.selected_carrier_id = None
        request.selected_bid_id = None
        request.status = RequestStatus.ACTIVE.value
        request.revision += 1
        try:
            add_request_history(db=db, request_id=request_id, event_type='carrier_declined', description='Перевозчик отказался от заявки', user_id=user_id, commit=False)
        except Exception as e:
            print(f'Ошибка при добавлении записи в историю: {e}')
        try:
            carrier = db.query(User).filter(User.id == user_id).first()
            carrier_name = carrier.company_name if carrier and carrier.company_name else carrier.full_name if carrier else 'Перевозчик'
            notification = Notification(user_id=request.customer_id, type='carrier_declined', title='Перевозчик отказался от заявки', message=f'Перевозчик {carrier_name} отказался от заявки: {request.from_city} → {request.to_city}', request_id=request.id, bid_id=request.selected_bid_id, is_read=False)
            db.add(notification)
        except Exception as e:
            print(f'Ошибка при создании уведомления: {e}')
        db.commit()
        return {'success': True, 'message': 'Отказ от заявки зарегистрирован', 'request_id': request_id, 'status': request.status}
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f'Ошибка при отказе от заявки: {str(e)}')

@app.post('/api/requests/{request_id}/auto-select')
async def auto_select_winner(request_id: int, db: Session=Depends(get_db), user_id: int=Depends(get_current_user_id)):
    """Автовыбор: оценка score = цена × (1 − (рейтинг−4.0)×0.1); минимальный score побеждает.
    Для экспресс — только среди 5 самых ранних по времени подачи ставок."""
    try:
        request = db.query(Request).filter(Request.id == request_id).first()
        if not request:
            raise HTTPException(status_code=404, detail='Заявка не найдена')
        if request.customer_id != user_id:
            raise HTTPException(status_code=403, detail='Только заказчик может выбрать победителя')
        if request.status != RequestStatus.ACTIVE.value:
            raise HTTPException(status_code=400, detail='Заявка больше не активна')
        bids = db.query(Bid).filter(Bid.request_id == request_id, Bid.is_rejected == False, Bid.is_active == True).all()
        if not bids:
            raise HTTPException(status_code=400, detail='Нет предложений для выбора')
        if request.is_express:
            candidates = sorted(bids, key=lambda b: b.created_at)[:5]
            if not candidates:
                candidates = bids[:5]
        else:
            candidates = bids
        scored_bids = []
        for bid in candidates:
            carrier_stats = db.query(Request).filter(Request.selected_carrier_id == bid.carrier_id).all()
            completed_count = sum((1 for r in carrier_stats if r.status == RequestStatus.COMPLETED.value))
            total_count = len(carrier_stats)
            success_rate = completed_count / total_count if total_count > 0 else 0
            confidence = min(1.0, total_count / 20.0)
            rating = 4.0 + success_rate * confidence
            score = bid.price * (1 - (rating - 4.0) * 0.1)
            scored_bids.append((bid, score, rating))
        selected_bid, selected_score, selected_rating = min(scored_bids, key=lambda x: x[1])
        db.query(Bid).filter(Bid.request_id == request_id).update({'is_rejected': True, 'is_active': False})
        selected_bid.is_selected = True
        selected_bid.is_rejected = False
        selected_bid.is_active = True
        request.selected_carrier_id = selected_bid.carrier_id
        request.selected_bid_id = selected_bid.id
        request.status = RequestStatus.AWAITING_CARRIER_CONFIRMATION.value
        request.closed_at = datetime.utcnow()
        request.revision += 1
        carrier = db.query(User).filter(User.id == selected_bid.carrier_id).first()
        carrier_name = carrier.company_name if carrier and carrier.company_name else carrier.full_name if carrier else 'Перевозчик'
        try:
            notification = Notification(user_id=selected_bid.carrier_id, type='bid_won', title='Вы выиграли заказ!', message=f'Ваше предложение было принято. Заказ: {request.from_city} → {request.to_city}. Цена: {selected_bid.price} ₸', request_id=request.id, bid_id=selected_bid.id, is_read=False)
            db.add(notification)
            print(f'Создано уведомление для пользователя {selected_bid.carrier_id} о заказе {request.id}')
        except Exception as e:
            print(f'Ошибка при создании уведомления: {e}')
        db.commit()
        return {'success': True, 'message': 'Победитель выбран автоматически', 'bid_id': selected_bid.id, 'carrier_id': selected_bid.carrier_id, 'price': selected_bid.price}
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f'Ошибка при автоматическом выборе: {str(e)}')

@app.post('/api/requests/{request_id}/request-completion')
async def request_completion(request_id: int, db: Session=Depends(get_db), user_id: int=Depends(get_current_user_id)):
    """Запрос на завершение заявки от перевозчика"""
    try:
        request = db.query(Request).filter(Request.id == request_id).first()
        if not request:
            raise HTTPException(status_code=404, detail='Заявка не найдена')
        if request.selected_carrier_id != user_id:
            raise HTTPException(status_code=403, detail='Только выбранный перевозчик может запросить завершение')
        if request.status != RequestStatus.IN_PROGRESS.value:
            raise HTTPException(status_code=400, detail="Заявка не находится в статусе 'В работе'")
        if not request.assigned_driver_id:
            raise HTTPException(status_code=400, detail='Нельзя завершить заявку без назначенного водителя')
        if not request.assigned_vehicle_id:
            raise HTTPException(status_code=400, detail='Нельзя завершить заявку без назначенной машины')
        if not request.contract_created_at:
            raise HTTPException(status_code=400, detail='Нельзя завершить заявку без созданного контракта')
        contract = db.query(Contract).filter(Contract.request_id == request_id).first()
        if not contract:
            raise HTTPException(status_code=400, detail='Контракт не найден')
        import json
        signatures_data = {}
        if contract.signature_cert_data:
            try:
                signatures_data = json.loads(contract.signature_cert_data)
            except:
                pass
        customer_signed = 'customer' in signatures_data and signatures_data['customer'] is not None
        carrier_signed = 'carrier' in signatures_data and signatures_data['carrier'] is not None
        if not (customer_signed and carrier_signed):
            raise HTTPException(status_code=400, detail='Нельзя завершить заявку без подписанного договора обеими сторонами')
        if not request.signed_act_path:
            raise HTTPException(status_code=400, detail='Нельзя завершить заявку без подписанного акта обеими сторонами')
        if not request.invoice_path:
            raise HTTPException(status_code=400, detail='Нельзя завершить заявку без созданного счета-фактуры')
        request.completion_requested_at = datetime.utcnow()
        request.revision += 1
        try:
            add_request_history(db=db, request_id=request_id, event_type='completion_requested', description='Перевозчик запросил завершение заявки', user_id=user_id, commit=False)
        except Exception as e:
            print(f'Ошибка при добавлении записи в историю: {e}')
        try:
            carrier = db.query(User).filter(User.id == user_id).first()
            carrier_name = carrier.company_name if carrier and carrier.company_name else carrier.full_name if carrier else 'Перевозчик'
            notification = Notification(user_id=request.customer_id, type='completion_requested', title='Запрос на завершение заявки', message=f'Перевозчик {carrier_name} запросил завершение заявки: {request.from_city} → {request.to_city}. Требуется ваше подтверждение.', request_id=request.id, bid_id=request.selected_bid_id, is_read=False)
            db.add(notification)
        except Exception as e:
            print(f'Ошибка при создании уведомления: {e}')
        db.commit()
        return {'success': True, 'message': 'Запрос на завершение отправлен заказчику', 'request_id': request_id}
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f'Ошибка при запросе завершения: {str(e)}')

@app.post('/api/requests/{request_id}/confirm-completion')
async def confirm_completion(request_id: int, db: Session=Depends(get_db), user_id: int=Depends(get_current_user_id)):
    """Подтверждение завершения заявки заказчиком"""
    try:
        request = db.query(Request).filter(Request.id == request_id).first()
        if not request:
            raise HTTPException(status_code=404, detail='Заявка не найдена')
        if request.customer_id != user_id:
            raise HTTPException(status_code=403, detail='Только заказчик может подтвердить завершение')
        if request.status != RequestStatus.IN_PROGRESS.value:
            raise HTTPException(status_code=400, detail="Заявка не находится в статусе 'В работе'")
        if not request.completion_requested_at:
            raise HTTPException(status_code=400, detail='Перевозчик еще не запросил завершение заявки')
        request.completion_confirmed_at = datetime.utcnow()
        request.status = RequestStatus.COMPLETED.value
        request.updated_at = datetime.utcnow()
        request.closed_at = datetime.utcnow()
        request.revision += 1
        try:
            add_request_history(db=db, request_id=request_id, event_type='request_completed', description='Заявка завершена и подтверждена заказчиком', user_id=user_id, commit=False)
        except Exception as e:
            print(f'Ошибка при добавлении записи в историю: {e}')
        try:
            notification = Notification(user_id=request.selected_carrier_id, type='request_completed', title='Заявка завершена', message=f'Заказчик подтвердил завершение заявки: {request.from_city} → {request.to_city}', request_id=request.id, bid_id=request.selected_bid_id, is_read=False)
            db.add(notification)
        except Exception as e:
            print(f'Ошибка при создании уведомления: {e}')
        db.commit()
        db.refresh(request)
        return {'success': True, 'message': 'Завершение заявки подтверждено', 'request_id': request_id, 'status': request.status}
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f'Ошибка при подтверждении завершения: {str(e)}')

@app.get('/api/notifications', response_model=List[NotificationResponse])
def get_notifications(db: Session=Depends(get_db), user_id: int=Depends(get_current_user_id), unread_only: bool=False):
    """Получение уведомлений пользователя"""
    try:
        query = db.query(Notification).filter(Notification.user_id == user_id)
        if unread_only:
            query = query.filter(Notification.is_read == False)
        notifications = query.order_by(Notification.created_at.desc()).limit(100).all()
        return notifications
    except Exception as e:
        print(f'Ошибка при получении уведомлений: {str(e)}')
        raise HTTPException(status_code=500, detail=f'Ошибка при получении уведомлений: {str(e)}')

@app.get('/api/notifications/unread-count')
def get_unread_count(db: Session=Depends(get_db), user_id: int=Depends(parse_x_user_id)):
    """Получение количества непрочитанных уведомлений (один round-trip: проверка user + COUNT)."""
    try:
        row = db.execute(text('\n                SELECT\n                    (SELECT COUNT(*)::bigint FROM users WHERE id = :uid) AS user_exists,\n                    (SELECT COUNT(*)::bigint FROM notifications\n                     WHERE user_id = :uid AND is_read IS FALSE) AS unread_cnt\n                '), {'uid': user_id}).one()
        if row[0] == 0:
            raise HTTPException(status_code=404, detail='Пользователь не найден')
        return {'count': int(row[1])}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f'Ошибка при получении количества: {str(e)}')

@app.post('/api/notifications/{notification_id}/read')
async def mark_notification_read(notification_id: int, db: Session=Depends(get_db), user_id: int=Depends(get_current_user_id)):
    """Отметить уведомление как прочитанное"""
    try:
        notification = db.query(Notification).filter(Notification.id == notification_id, Notification.user_id == user_id).first()
        if not notification:
            raise HTTPException(status_code=404, detail='Уведомление не найдено')
        notification.is_read = True
        db.commit()
        return {'success': True, 'message': 'Уведомление отмечено как прочитанное'}
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f'Ошибка при обновлении уведомления: {str(e)}')

@app.post('/api/notifications/read-all')
async def mark_all_notifications_read(db: Session=Depends(get_db), user_id: int=Depends(get_current_user_id)):
    """Отметить все уведомления как прочитанные"""
    try:
        db.query(Notification).filter(Notification.user_id == user_id, Notification.is_read == False).update({'is_read': True})
        db.commit()
        return {'success': True, 'message': 'Все уведомления отмечены как прочитанные'}
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f'Ошибка при обновлении уведомлений: {str(e)}')

@app.delete('/api/notifications/{notification_id}')
async def delete_notification(notification_id: int, db: Session=Depends(get_db), user_id: int=Depends(get_current_user_id)):
    """Удаление уведомления"""
    notification = db.query(Notification).filter(Notification.id == notification_id, Notification.user_id == user_id).first()
    if not notification:
        raise HTTPException(status_code=404, detail='Уведомление не найдено')
    try:
        db.delete(notification)
        db.commit()
        return {'message': 'Уведомление удалено'}
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f'Ошибка при удалении уведомления: {str(e)}')

@app.post('/api/drivers', response_model=DriverResponse)
async def create_driver(driver_data: DriverCreate, db: Session=Depends(get_db), user_id: int=Depends(get_current_user_id)):
    """Создание нового водителя"""
    try:
        new_driver = Driver(carrier_id=user_id, full_name=driver_data.full_name, birth_date=driver_data.birth_date, personnel_number=driver_data.personnel_number, phone=driver_data.phone, passport_type=driver_data.passport_type, passport_series=driver_data.passport_series, passport_number=driver_data.passport_number, passport_issue_date=driver_data.passport_issue_date, passport_issued_by=driver_data.passport_issued_by, registration_address=driver_data.registration_address, inn=driver_data.inn, license_type=driver_data.license_type, license_series=driver_data.license_series, license_number=driver_data.license_number, license_issue_date=driver_data.license_issue_date)
        db.add(new_driver)
        db.commit()
        db.refresh(new_driver)
        return DriverResponse.model_validate(new_driver)
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f'Ошибка при создании водителя: {str(e)}')

@app.get('/api/drivers', response_model=List[DriverResponse])
async def get_drivers(db: Session=Depends(get_db), user_id: int=Depends(get_current_user_id)):
    """Получение списка водителей текущего пользователя"""
    try:
        drivers = db.query(Driver).filter(Driver.carrier_id == user_id).order_by(Driver.created_at.desc()).all()
        return [DriverResponse.model_validate(driver) for driver in drivers]
    except Exception as e:
        raise HTTPException(status_code=500, detail=f'Ошибка при получении водителей: {str(e)}')

@app.get('/api/drivers/{driver_id}', response_model=DriverResponse)
async def get_driver(driver_id: int, db: Session=Depends(get_db), user_id: int=Depends(get_current_user_id)):
    """Получение конкретного водителя"""
    driver = db.query(Driver).filter(Driver.id == driver_id, Driver.carrier_id == user_id).first()
    if not driver:
        raise HTTPException(status_code=404, detail='Водитель не найден')
    return DriverResponse.model_validate(driver)

@app.put('/api/drivers/{driver_id}', response_model=DriverResponse)
async def update_driver(driver_id: int, driver_data: DriverCreate, db: Session=Depends(get_db), user_id: int=Depends(get_current_user_id)):
    """Обновление водителя"""
    driver = db.query(Driver).filter(Driver.id == driver_id, Driver.carrier_id == user_id).first()
    if not driver:
        raise HTTPException(status_code=404, detail='Водитель не найден')
    try:
        driver.full_name = driver_data.full_name
        driver.birth_date = driver_data.birth_date
        driver.personnel_number = driver_data.personnel_number
        driver.phone = driver_data.phone
        driver.passport_type = driver_data.passport_type
        driver.passport_series = driver_data.passport_series
        driver.passport_number = driver_data.passport_number
        driver.passport_issue_date = driver_data.passport_issue_date
        driver.passport_issued_by = driver_data.passport_issued_by
        driver.registration_address = driver_data.registration_address
        driver.inn = driver_data.inn
        driver.license_type = driver_data.license_type
        driver.license_series = driver_data.license_series
        driver.license_number = driver_data.license_number
        driver.license_issue_date = driver_data.license_issue_date
        db.commit()
        db.refresh(driver)
        return DriverResponse.model_validate(driver)
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f'Ошибка при обновлении водителя: {str(e)}')

@app.delete('/api/drivers/{driver_id}')
async def delete_driver(driver_id: int, db: Session=Depends(get_db), user_id: int=Depends(get_current_user_id)):
    """Удаление водителя"""
    driver = db.query(Driver).filter(Driver.id == driver_id, Driver.carrier_id == user_id).first()
    if not driver:
        raise HTTPException(status_code=404, detail='Водитель не найден')
    try:
        db.delete(driver)
        db.commit()
        return {'message': 'Водитель удален'}
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f'Ошибка при удалении водителя: {str(e)}')

def _vehicle_response(vehicle: Vehicle) -> VehicleResponse:
    return VehicleResponse.model_validate(vehicle_to_response_dict(vehicle))

@app.get('/api/meta/vehicle-enums')
async def get_vehicle_enums():
    """Справочники состава ТС и типа кузова для форм."""
    return meta_vehicle_enums()

@app.post('/api/vehicles', response_model=VehicleResponse)
async def create_vehicle(vehicle_data: VehicleCreate, db: Session=Depends(get_db), user_id: int=Depends(get_current_user_id)):
    """Создание нового транспортного средства"""
    try:
        vt_label, bt_label = persist_labels_from_codes(vehicle_data.vehicle_composition, vehicle_data.cargo_body_type)
        new_vehicle = Vehicle(carrier_id=user_id, vehicle_composition=vehicle_data.vehicle_composition, cargo_body_type=vehicle_data.cargo_body_type, vehicle_type=vehicle_data.vehicle_type or vt_label, actual_carrier=vehicle_data.actual_carrier, carrier_registration_country=vehicle_data.carrier_registration_country, tractor_registration=vehicle_data.tractor_registration, tractor_license_plate=vehicle_data.tractor_license_plate, tractor_brand=vehicle_data.tractor_brand, trailer_registration=vehicle_data.trailer_registration, trailer_license_plate=vehicle_data.trailer_license_plate, trailer_brand=vehicle_data.trailer_brand, body_type=vehicle_data.body_type or bt_label, tonnage=vehicle_data.tonnage, volume=vehicle_data.volume, pallet_spaces=vehicle_data.pallet_spaces, length_m=vehicle_data.length_m, width_m=vehicle_data.width_m, height_m=vehicle_data.height_m, temp_min_c=vehicle_data.temp_min_c, temp_max_c=vehicle_data.temp_max_c, adr_class=vehicle_data.adr_class, phone=vehicle_data.phone, description=vehicle_data.description)
        db.add(new_vehicle)
        db.commit()
        db.refresh(new_vehicle)
        return _vehicle_response(new_vehicle)
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f'Ошибка при создании транспортного средства: {str(e)}')

@app.get('/api/vehicles', response_model=List[VehicleResponse])
async def get_vehicles(db: Session=Depends(get_db), user_id: int=Depends(get_current_user_id), composition: Optional[str]=Query(None, description='Фильтр по vehicle_composition'), cargo_body_type: Optional[str]=Query(None, description='Фильтр по типу кузова'), min_tons: Optional[float]=Query(None, ge=0, description='Мин. тоннаж'), max_tons: Optional[float]=Query(None, ge=0, description='Макс. тоннаж')):
    """Получение списка транспортных средств текущего пользователя"""
    try:
        q = db.query(Vehicle).filter(Vehicle.carrier_id == user_id)
        if composition:
            q = q.filter(Vehicle.vehicle_composition == composition)
        if cargo_body_type:
            q = q.filter(Vehicle.cargo_body_type == cargo_body_type)
        if min_tons is not None:
            q = q.filter(Vehicle.tonnage >= min_tons)
        if max_tons is not None:
            q = q.filter(Vehicle.tonnage <= max_tons)
        vehicles = q.order_by(Vehicle.created_at.desc()).all()
        return [_vehicle_response(vehicle) for vehicle in vehicles]
    except Exception as e:
        raise HTTPException(status_code=500, detail=f'Ошибка при получении транспортных средств: {str(e)}')

@app.get('/api/vehicles/{vehicle_id}', response_model=VehicleResponse)
async def get_vehicle(vehicle_id: int, db: Session=Depends(get_db), user_id: int=Depends(get_current_user_id)):
    """Получение конкретного транспортного средства"""
    vehicle = db.query(Vehicle).filter(Vehicle.id == vehicle_id, Vehicle.carrier_id == user_id).first()
    if not vehicle:
        raise HTTPException(status_code=404, detail='Транспортное средство не найдено')
    return _vehicle_response(vehicle)

@app.put('/api/vehicles/{vehicle_id}', response_model=VehicleResponse)
async def update_vehicle(vehicle_id: int, vehicle_data: VehicleCreate, db: Session=Depends(get_db), user_id: int=Depends(get_current_user_id)):
    """Обновление транспортного средства"""
    vehicle = db.query(Vehicle).filter(Vehicle.id == vehicle_id, Vehicle.carrier_id == user_id).first()
    if not vehicle:
        raise HTTPException(status_code=404, detail='Транспортное средство не найдено')
    try:
        vt_label, bt_label = persist_labels_from_codes(vehicle_data.vehicle_composition, vehicle_data.cargo_body_type)
        vehicle.vehicle_composition = vehicle_data.vehicle_composition
        vehicle.cargo_body_type = vehicle_data.cargo_body_type
        vehicle.vehicle_type = vehicle_data.vehicle_type or vt_label
        vehicle.actual_carrier = vehicle_data.actual_carrier
        vehicle.carrier_registration_country = vehicle_data.carrier_registration_country
        vehicle.tractor_registration = vehicle_data.tractor_registration
        vehicle.tractor_license_plate = vehicle_data.tractor_license_plate
        vehicle.tractor_brand = vehicle_data.tractor_brand
        vehicle.trailer_registration = vehicle_data.trailer_registration
        vehicle.trailer_license_plate = vehicle_data.trailer_license_plate
        vehicle.trailer_brand = vehicle_data.trailer_brand
        vehicle.body_type = vehicle_data.body_type or bt_label
        vehicle.tonnage = vehicle_data.tonnage
        vehicle.volume = vehicle_data.volume
        vehicle.pallet_spaces = vehicle_data.pallet_spaces
        vehicle.length_m = vehicle_data.length_m
        vehicle.width_m = vehicle_data.width_m
        vehicle.height_m = vehicle_data.height_m
        vehicle.temp_min_c = vehicle_data.temp_min_c
        vehicle.temp_max_c = vehicle_data.temp_max_c
        vehicle.adr_class = vehicle_data.adr_class
        vehicle.phone = vehicle_data.phone
        vehicle.description = vehicle_data.description
        db.commit()
        db.refresh(vehicle)
        return _vehicle_response(vehicle)
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f'Ошибка при обновлении транспортного средства: {str(e)}')

@app.delete('/api/vehicles/{vehicle_id}')
async def delete_vehicle(vehicle_id: int, db: Session=Depends(get_db), user_id: int=Depends(get_current_user_id)):
    """Удаление транспортного средства"""
    vehicle = db.query(Vehicle).filter(Vehicle.id == vehicle_id, Vehicle.carrier_id == user_id).first()
    if not vehicle:
        raise HTTPException(status_code=404, detail='Транспортное средство не найдено')
    try:
        db.delete(vehicle)
        db.commit()
        return {'message': 'Транспортное средство удалено'}
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f'Ошибка при удалении транспортного средства: {str(e)}')

def add_request_history(db: Session, request_id: int, event_type: str, description: str, user_id: Optional[int]=None, metadata: Optional[dict]=None, commit: bool=False):
    """Добавление записи в историю изменений заявки"""
    import json
    history = RequestHistory(request_id=request_id, event_type=event_type, description=description, user_id=user_id, event_metadata=json.dumps(metadata, ensure_ascii=False) if metadata else None)
    db.add(history)
    if commit:
        db.commit()
    return history

@app.post('/api/requests/{request_id}/assign-driver')
async def assign_driver_to_request(request_id: int, driver_id: int, db: Session=Depends(get_db), user_id: int=Depends(get_current_user_id)):
    """Назначение водителя на заявку (только для победителя аукциона)"""
    try:
        request = db.query(Request).filter(Request.id == request_id).first()
        if not request:
            raise HTTPException(status_code=404, detail='Заявка не найдена')
        if request.selected_carrier_id != user_id:
            raise HTTPException(status_code=403, detail='Только победитель аукциона может назначать водителя')
        if request.status != RequestStatus.IN_PROGRESS.value:
            raise HTTPException(status_code=400, detail='Водителя можно назначить только для заявки в работе')
        driver = db.query(Driver).filter(Driver.id == driver_id, Driver.carrier_id == user_id).first()
        if not driver:
            raise HTTPException(status_code=404, detail='Водитель не найден или не принадлежит вам')
        request.assigned_driver_id = driver_id
        db.commit()
        driver_info = f'{driver.full_name}'
        if driver.birth_date:
            driver_info += f", дата рождения {driver.birth_date.strftime('%d.%m.%Y')}"
        if driver.phone:
            driver_info += f', тел.: {driver.phone}'
        add_request_history(db=db, request_id=request_id, event_type='driver_assigned', description=f'Назначен водитель: {driver_info}', user_id=user_id, commit=False)
        db.refresh(request)
        return {'success': True, 'message': 'Водитель успешно назначен', 'driver': {'id': driver.id, 'full_name': driver.full_name, 'phone': driver.phone}}
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f'Ошибка при назначении водителя: {str(e)}')

@app.post('/api/requests/{request_id}/assign-vehicle')
async def assign_vehicle_to_request(request_id: int, vehicle_id: int, db: Session=Depends(get_db), user_id: int=Depends(get_current_user_id)):
    """Назначение машины на заявку (только для победителя аукциона)"""
    try:
        request = db.query(Request).filter(Request.id == request_id).first()
        if not request:
            raise HTTPException(status_code=404, detail='Заявка не найдена')
        if request.selected_carrier_id != user_id:
            raise HTTPException(status_code=403, detail='Только победитель аукциона может назначать машину')
        if request.status != RequestStatus.IN_PROGRESS.value:
            raise HTTPException(status_code=400, detail='Машину можно назначить только для заявки в работе')
        vehicle = db.query(Vehicle).filter(Vehicle.id == vehicle_id, Vehicle.carrier_id == user_id).first()
        if not vehicle:
            raise HTTPException(status_code=404, detail='Машина не найдена или не принадлежит вам')
        request.assigned_vehicle_id = vehicle_id
        db.commit()
        vehicle_info_parts = []
        if vehicle.tractor_brand and vehicle.tractor_license_plate:
            vehicle_info_parts.append(f'{vehicle.tractor_brand} {vehicle.tractor_license_plate}')
        if vehicle.trailer_brand and vehicle.trailer_license_plate:
            vehicle_info_parts.append(f'{vehicle.trailer_brand} {vehicle.trailer_license_plate}')
        vehicle_description = ', '.join(vehicle_info_parts) if vehicle_info_parts else f'ID: {vehicle.id}'
        add_request_history(db=db, request_id=request_id, event_type='vehicle_assigned', description=f'Назначена машина: {vehicle_description}', user_id=user_id, commit=False)
        db.refresh(request)
        return {'success': True, 'message': 'Машина успешно назначена', 'vehicle': {'id': vehicle.id, 'description': vehicle_description}}
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f'Ошибка при назначении машины: {str(e)}')

@app.post('/api/requests/{request_id}/create-contract')
async def create_contract(request_id: int, db: Session=Depends(get_db), user_id: int=Depends(get_current_user_id)):
    """Создание контракта (только для победителя аукциона после назначения водителя и машины)"""
    try:
        request = db.query(Request).filter(Request.id == request_id).first()
        if not request:
            raise HTTPException(status_code=404, detail='Заявка не найдена')
        if request.selected_carrier_id != user_id:
            raise HTTPException(status_code=403, detail='Только победитель аукциона может создавать контракт')
        if request.status != RequestStatus.IN_PROGRESS.value:
            raise HTTPException(status_code=400, detail='Контракт можно создать только для заявки в работе')
        if not request.assigned_driver_id:
            raise HTTPException(status_code=400, detail='Сначала назначьте водителя')
        if not request.assigned_vehicle_id:
            raise HTTPException(status_code=400, detail='Сначала назначьте машину')
        existing_contract = db.query(Contract).filter(Contract.request_id == request_id).first()
        if existing_contract:
            raise HTTPException(status_code=400, detail='Договор-заявка уже создан')
        customer = db.query(User).filter(User.id == request.customer_id).first()
        if not customer:
            raise HTTPException(status_code=404, detail='Заказчик не найден')
        carrier = db.query(User).filter(User.id == user_id).first()
        if not carrier:
            raise HTTPException(status_code=404, detail='Перевозчик не найден')
        driver = db.query(Driver).filter(Driver.id == request.assigned_driver_id).first()
        if not driver:
            raise HTTPException(status_code=404, detail='Водитель не найден')
        vehicle = db.query(Vehicle).filter(Vehicle.id == request.assigned_vehicle_id).first()
        if not vehicle:
            raise HTTPException(status_code=404, detail='Машина не найдена')
        selected_bid = None
        if request.selected_bid_id:
            selected_bid = db.query(Bid).filter(Bid.id == request.selected_bid_id).first()
        from pathlib import Path
        from weasyprint import HTML
        from io import BytesIO
        import os

        def format_date_ru(dt):
            if not dt:
                return None
            return dt.strftime('%d.%m.%Y')

        def format_date_ru_long(dt):
            if not dt:
                return ''
            months = ('', 'января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря')
            return f'«{dt.day}» {months[dt.month]} {dt.year} г.'
        request_number = str(request.id)
        request_date = format_date_ru(request.created_at) if request.created_at else format_date_ru(datetime.utcnow())
        template_data = {'request_number': request_number, 'request_date': request_date, 'customer_company': customer.company_name or customer.full_name or 'Не указан', 'customer_contact': customer.full_name or '', 'customer_phone': customer.phone or '', 'customer_accounting_phone': '', 'customer_accounting_email': '', 'customer_inn': customer.iin or '', 'customer_bin': (customer.bin or '').strip(), 'customer_address': (customer.address or '').strip() or '____________________________', 'customer_kpp': '', 'carrier_company': carrier.company_name or carrier.full_name if carrier else '', 'carrier_contact': carrier.full_name if carrier else '', 'carrier_phone': carrier.phone if carrier else '', 'carrier_accounting_phone': '', 'carrier_accounting_email': '', 'carrier_inn': carrier.iin if carrier else '', 'carrier_bin': (carrier.bin or '').strip() if carrier else '', 'carrier_address': (carrier.address or '').strip() or '____________________________' if carrier else '____________________________', 'carrier_kpp': '', 'loading_date': format_date_ru(request.loading_date) if request.loading_date else '', 'loading_time': request.loading_date.strftime('%H:%M') if request.loading_date else '', 'loading_address': request.from_address or request.from_city or 'Не указан', 'loading_contact': '', 'loading_phone': '', 'loading_info': '', 'delivery_date': format_date_ru(request.delivery_date) if request.delivery_date else '', 'delivery_time': request.delivery_date.strftime('%H:%M') if request.delivery_date else '', 'delivery_address': request.to_address or request.to_city or 'Не указан', 'delivery_contact': '', 'delivery_phone': '', 'delivery_info': '', 'cargo_name': request.cargo_type or '', 'cargo_weight': f'{request.cargo_weight:.1f}' if request.cargo_weight else '', 'cargo_volume': f'{request.cargo_volume:.1f}' if request.cargo_volume else '', 'body_type': request.body_type or '', 'loading_type': '', 'cargo_requirements': '', 'price': f'{selected_bid.price:,.0f}'.replace(',', ' ') if selected_bid and selected_bid.price else f'{request.max_price:,.0f}'.replace(',', ' ') if request.max_price else '', 'payment_terms': '', 'driver_name': driver.full_name if driver else '', 'driver_phone': driver.phone if driver else '', 'driver_passport': f"{driver.passport_series or ''} {driver.passport_number or ''}".strip() if driver else '', 'driver_passport_issued': driver.passport_issued_by if driver and driver.passport_issued_by else '', 'driver_birth_date': format_date_ru(driver.birth_date) if driver and driver.birth_date else '', 'vehicle_info': ''}
        if vehicle:
            vehicle_parts = []
            if vehicle.tractor_brand and vehicle.tractor_license_plate:
                vehicle_parts.append(f'Тягач {vehicle.tractor_brand} {vehicle.tractor_license_plate}')
            if vehicle.trailer_brand and vehicle.trailer_license_plate:
                vehicle_parts.append(f'{vehicle.trailer_brand} {vehicle.trailer_license_plate}')
            bt_disp = vehicle_body_display_label(vehicle.cargo_body_type or vehicle.body_type)
            if bt_disp:
                vehicle_parts.append(f', {bt_disp}')
            template_data['vehicle_info'] = ' '.join(vehicle_parts) if vehicle_parts else ''
        else:
            template_data['vehicle_info'] = ''
        months_ru_long = ('', 'января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря')

        def _create_contract_format_date_ru_long(dt):
            if not dt:
                return ''
            return f'«{dt.day}» {months_ru_long[dt.month]} {dt.year} г.'
        loading_date_long = _create_contract_format_date_ru_long(request.loading_date) if request.loading_date else ''
        delivery_date_long = _create_contract_format_date_ru_long(request.delivery_date) if request.delivery_date else ''
        contract_for_request = db.query(Contract).filter(Contract.request_id == request.id).order_by(Contract.id.desc()).first()
        contract_frame_date_long = ''
        if contract_for_request:
            contract_frame_date_long = _create_contract_format_date_ru_long(contract_for_request.signed_at or contract_for_request.created_at)
        desc_l = (request.description or '').lower()
        bt_l = (request.body_type or '').lower()
        body_tent = 'тент' in bt_l
        body_isotherm = 'изотерм' in bt_l
        body_reefer = 'реф' in bt_l or 'рефриж' in bt_l
        body_other = bool((request.body_type or '').strip()) and (not (body_tent or body_isotherm or body_reefer))
        cargo_fragile = 'хруп' in desc_l
        cargo_oversized = 'негабар' in desc_l
        cargo_temp = 'температ' in desc_l or body_reefer
        cargo_normal = not (cargo_fragile or cargo_oversized or cargo_temp)
        c_bin = (customer.bin or '').strip() or (customer.iin or '').strip()
        carrier_bin_parts = []
        if carrier:
            if (carrier.bin or '').strip():
                carrier_bin_parts.append(carrier.bin.strip())
            if (carrier.iin or '').strip():
                carrier_bin_parts.append(carrier.iin.strip())
        carrier_bin_iin_val = ' / '.join(carrier_bin_parts) if carrier_bin_parts else ''
        if request.cargo_weight is not None:
            cargo_weight_kg_val = f'{request.cargo_weight * 1000:.0f}'
        else:
            cargo_weight_kg_val = ''
        template_data.update({'platform_name': 'AituCargo', 'contract_frame_number': str(request.id), 'contract_frame_date_long': contract_frame_date_long, 'customer_bin': c_bin, 'carrier_bin_iin': carrier_bin_iin_val, 'customer_email': (customer.email or '').strip(), 'carrier_email': (carrier.email or '').strip() if carrier else '', 'loading_date_long': loading_date_long, 'delivery_date_long': delivery_date_long, 'loading_time_from': template_data.get('loading_time') or '', 'loading_time_to': '________', 'delivery_time_from': template_data.get('delivery_time') or '', 'delivery_time_to': '________', 'cargo_weight_kg': cargo_weight_kg_val, 'cargo_places': '', 'temperature_regime': (request.conditions or '').strip()[:500], 'body_tent': body_tent, 'body_isotherm': body_isotherm, 'body_reefer': body_reefer, 'body_other': body_other, 'body_other_text': (request.body_type or '').strip() if body_other else '', 'cargo_normal': cargo_normal, 'cargo_fragile': cargo_fragile, 'cargo_oversized': cargo_oversized, 'cargo_temp': cargo_temp, 'vat_included': False, 'vat_not_included': True, 'vehicle_type_display': vehicle_composition_display_label(resolve_composition_code(vehicle)) if vehicle else ''})
        backend_dir = Path(__file__).parent
        template_path = Path('templates') / 'request_document.html'
        if not template_path.exists():
            template_path = backend_dir / 'templates' / 'request_document.html'
        if not template_path.exists():
            raise HTTPException(status_code=500, detail='Шаблон документа заявки (request_document.html) не найден')
        template = Template(template_path.read_text(encoding='utf-8'))
        html_content = template.render(**template_data)
        try:
            if os.path.exists('/opt/homebrew/lib'):
                os.environ['DYLD_LIBRARY_PATH'] = '/opt/homebrew/lib'
            elif os.path.exists('/usr/local/lib'):
                os.environ['DYLD_LIBRARY_PATH'] = '/usr/local/lib'
            pdf_buffer = BytesIO()
            html_doc = HTML(string=html_content, base_url=str(backend_dir))
            html_doc.write_pdf(pdf_buffer)
            pdf_bytes = pdf_buffer.getvalue()
            pdf_buffer.close()
            if not pdf_bytes or len(pdf_bytes) == 0:
                raise Exception('PDF файл пуст или не был создан')
        except ImportError:
            raise HTTPException(status_code=500, detail='Библиотека weasyprint не установлена. Установите: pip install weasyprint')
        except Exception as e:
            import traceback
            error_details = traceback.format_exc()
            print(f'Ошибка генерации PDF: {error_details}')
            raise HTTPException(status_code=500, detail=f'Ошибка генерации PDF: {str(e)}')
        backend_dir = Path(__file__).parent
        contracts_dir = backend_dir / 'contracts'
        contracts_dir.mkdir(exist_ok=True)
        document_filename = f"request_{request_id}_contract_{datetime.utcnow().strftime('%Y%m%d_%H%M%S')}.pdf"
        document_path = contracts_dir / document_filename
        with open(document_path, 'wb') as f:
            f.write(pdf_bytes)
        new_contract = Contract(request_id=request_id, carrier_id=user_id, customer_id=request.customer_id, driver_id=request.assigned_driver_id, vehicle_id=request.assigned_vehicle_id, status=ContractStatus.PENDING_APPROVAL.value, document_path=f'contracts/{document_filename}')
        db.add(new_contract)
        request.contract_created_at = datetime.utcnow()
        add_request_history(db=db, request_id=request_id, event_type='contract_created', description='Создан договор-заявка на перевозку. Заявка согласована, данные зафиксированы.', user_id=user_id, commit=False)
        try:
            notification = Notification(user_id=request.customer_id, type='contract_created', title='Создан договор-заявка на перевозку', message=f'Перевозчик создал договор-заявку для заявки №{request_id}. Требуется ваше утверждение и подпись.', request_id=request_id, is_read=False)
            db.add(notification)
        except Exception as e:
            print(f'Ошибка при создании уведомления: {e}')
        db.commit()
        db.refresh(new_contract)
        db.refresh(request)
        return {'success': True, 'message': 'Договор-заявка успешно создан. Заявка согласована, данные зафиксированы.', 'contract_id': new_contract.id, 'contract_created_at': request.contract_created_at, 'status': new_contract.status, 'document_path': new_contract.document_path}
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f'Ошибка при создании контракта: {str(e)}')

@app.get('/api/requests/{request_id}/history', response_model=List[RequestHistoryResponse])
def get_request_history(request_id: int, db: Session=Depends(get_db), user_id: int=Depends(get_current_user_id)):
    """Получение истории изменений заявки"""
    try:
        request = db.query(Request).filter(Request.id == request_id).first()
        if not request:
            raise HTTPException(status_code=404, detail='Заявка не найдена')
        if not _user_can_access_request_documents(user_id, request):
            raise HTTPException(status_code=404, detail='История не найдена')
        history = db.query(RequestHistory).filter(RequestHistory.request_id == request_id).order_by(RequestHistory.created_at.desc()).all()
        print(f'[DEBUG] Запрос истории для request_id={request_id}, найдено записей: {len(history)}')
        filtered_history = [h for h in history if h.request_id == request_id]
        if len(filtered_history) != len(history):
            print(f'[WARNING] Найдены записи с неправильным request_id! Всего: {len(history)}, правильных: {len(filtered_history)}')
            for h in history:
                if h.request_id != request_id:
                    print(f'  - НЕПРАВИЛЬНАЯ ЗАПИСЬ: ID={h.id}, request_id={h.request_id} (ожидалось {request_id}), event={h.event_type}')
        history = filtered_history
        result = []
        for h in history:
            if h.request_id != request_id:
                print(f'[ERROR] Пропускаем запись с неправильным request_id: {h.id}')
                continue
            user_name = None
            if h.user_id:
                user = db.query(User).filter(User.id == h.user_id).first()
                if user:
                    user_name = user.full_name or user.company_name
            result.append(RequestHistoryResponse(id=h.id, request_id=h.request_id, event_type=h.event_type, description=h.description, user_id=h.user_id, user_name=user_name, metadata=h.event_metadata, created_at=h.created_at))
        print(f'[DEBUG] Возвращаем {len(result)} записей истории для request_id={request_id}')
        return result
    except HTTPException:
        raise
    except Exception as e:
        print(f'[ERROR] Ошибка при получении истории для request_id={request_id}: {str(e)}')
        raise HTTPException(status_code=500, detail=f'Ошибка при получении истории: {str(e)}')

@app.get('/api/requests/carriers/{carrier_id}/stats')
async def get_carrier_stats(carrier_id: int, db: Session=Depends(get_db)):
    """Получение статистики перевозчика"""
    try:
        carrier = db.query(User).filter(User.id == carrier_id).first()
        if not carrier:
            raise HTTPException(status_code=404, detail='Перевозчик не найден')
        from sqlalchemy import func, and_
        all_carrier_requests = db.query(Request).filter(Request.selected_carrier_id == carrier_id).all()
        completed_count = 0
        active_count = 0
        total_count = len(all_carrier_requests)
        for r in all_carrier_requests:
            status = (r.status or '').strip().lower()
            if status == 'completed':
                completed_count += 1
            elif status == 'in_progress':
                active_count += 1
        print(f'[STATS] Перевозчик {carrier_id}: всего={total_count}, завершено={completed_count}, в работе={active_count}')
        for r in all_carrier_requests:
            print(f"  - Заявка {r.id}: статус='{r.status}' (repr: {repr(r.status)}), selected_carrier_id={r.selected_carrier_id}")
        success_rate = completed_count / total_count if total_count > 0 else 0
        confidence = min(1.0, total_count / 20.0)
        rating = 4.0 + success_rate * confidence
        rating = min(5.0, max(0.0, rating))
        reviews_count = 0
        return {'carrier_id': carrier_id, 'carrier_name': carrier.full_name, 'carrier_company': carrier.company_name, 'completed_requests': completed_count, 'active_requests': active_count, 'total_requests': total_count, 'rating': round(rating, 1), 'reviews_count': reviews_count, 'registered_at': carrier.created_at.isoformat() if carrier.created_at else None}
    except HTTPException:
        raise
    except Exception as e:
        print(f'Ошибка при получении статистики перевозчика {carrier_id}: {str(e)}')
        raise HTTPException(status_code=500, detail=f'Ошибка при получении статистики: {str(e)}')

@app.get('/api/requests/{request_id}/contract', response_model=ContractResponse)
async def get_contract(request_id: int, db: Session=Depends(get_db), user_id: int=Depends(get_current_user_id)):
    """Получение контракта для заявки"""
    try:
        request = db.query(Request).filter(Request.id == request_id).first()
        if not request:
            raise HTTPException(status_code=404, detail='Заявка не найдена')
        if request.customer_id != user_id and request.selected_carrier_id != user_id:
            raise HTTPException(status_code=403, detail='Нет доступа к контракту этой заявки')
        contract = db.query(Contract).filter(Contract.request_id == request_id).first()
        if not contract:
            raise HTTPException(status_code=404, detail='Контракт не найден')
        driver = db.query(Driver).filter(Driver.id == contract.driver_id).first()
        vehicle = db.query(Vehicle).filter(Vehicle.id == contract.vehicle_id).first()
        carrier = db.query(User).filter(User.id == contract.carrier_id).first()
        customer = db.query(User).filter(User.id == contract.customer_id).first()
        vehicle_info_parts = []
        if vehicle:
            if vehicle.tractor_brand and vehicle.tractor_license_plate:
                vehicle_info_parts.append(f'{vehicle.tractor_brand} {vehicle.tractor_license_plate}')
            if vehicle.trailer_brand and vehicle.trailer_license_plate:
                vehicle_info_parts.append(f'{vehicle.trailer_brand} {vehicle.trailer_license_plate}')
        vehicle_info = ', '.join(vehicle_info_parts) if vehicle_info_parts else 'Не указана'
        response_data = {'id': contract.id, 'request_id': contract.request_id, 'carrier_id': contract.carrier_id, 'customer_id': contract.customer_id, 'driver_id': contract.driver_id, 'vehicle_id': contract.vehicle_id, 'status': contract.status, 'document_path': contract.document_path, 'signed_document_path': contract.signed_document_path, 'signature_xml': contract.signature_xml, 'signature_cert_data': contract.signature_cert_data, 'created_at': contract.created_at, 'approved_at': contract.approved_at, 'document_uploaded_at': contract.document_uploaded_at, 'signed_at': contract.signed_at, 'rejected_at': contract.rejected_at, 'rejection_reason': contract.rejection_reason, 'power_of_attorney_path': getattr(contract, 'power_of_attorney_path', None), 'signed_power_of_attorney_path': getattr(contract, 'signed_power_of_attorney_path', None), 'power_of_attorney_signature_xml': getattr(contract, 'power_of_attorney_signature_xml', None), 'power_of_attorney_signature_cert_data': getattr(contract, 'power_of_attorney_signature_cert_data', None), 'driver_name': driver.full_name if driver else 'Не найден', 'vehicle_info': vehicle_info, 'carrier_name': carrier.company_name if carrier and carrier.company_name else carrier.full_name if carrier else 'Не найден', 'customer_name': customer.company_name if customer and customer.company_name else customer.full_name if customer else 'Не найден'}
        response = ContractResponse(**response_data)
        return response
    except HTTPException:
        raise
    except Exception as e:
        import traceback
        error_details = traceback.format_exc()
        print(f'Ошибка при получении контракта: {error_details}')
        raise HTTPException(status_code=500, detail=f'Ошибка при получении контракта: {str(e)}')

@app.post('/api/contracts/{contract_id}/approve')
async def approve_contract(contract_id: int, db: Session=Depends(get_db), user_id: int=Depends(get_current_user_id)):
    """Утверждение контракта заказчиком"""
    try:
        contract = db.query(Contract).filter(Contract.id == contract_id).first()
        if not contract:
            raise HTTPException(status_code=404, detail='Контракт не найден')
        if contract.customer_id != user_id:
            raise HTTPException(status_code=403, detail='Только заказчик может утвердить контракт')
        if contract.status != ContractStatus.PENDING_APPROVAL.value:
            raise HTTPException(status_code=400, detail=f'Контракт уже {contract.status}')
        contract.status = ContractStatus.APPROVED.value
        contract.approved_at = datetime.utcnow()
        add_request_history(db=db, request_id=contract.request_id, event_type='contract_approved', description='Контракт утвержден заказчиком', user_id=user_id, commit=False)
        try:
            notification = Notification(user_id=contract.carrier_id, type='contract_approved', title='Контракт утвержден', message=f'Заказчик утвердил контракт для заявки №{contract.request_id}. Теперь можно загрузить договор.', request_id=contract.request_id, is_read=False)
            db.add(notification)
        except Exception as e:
            print(f'Ошибка при создании уведомления: {e}')
        db.commit()
        db.refresh(contract)
        return {'success': True, 'message': 'Контракт успешно утвержден', 'contract_id': contract.id, 'status': contract.status}
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f'Ошибка при утверждении контракта: {str(e)}')

@app.post('/api/contracts/{contract_id}/reject')
async def reject_contract(contract_id: int, rejection_reason: Optional[str]=Form(None), db: Session=Depends(get_db), user_id: int=Depends(get_current_user_id)):
    """Отклонение контракта заказчиком"""
    try:
        contract = db.query(Contract).filter(Contract.id == contract_id).first()
        if not contract:
            raise HTTPException(status_code=404, detail='Контракт не найден')
        if contract.customer_id != user_id:
            raise HTTPException(status_code=403, detail='Только заказчик может отклонить контракт')
        if contract.status != ContractStatus.PENDING_APPROVAL.value:
            raise HTTPException(status_code=400, detail=f'Контракт уже {contract.status}')
        contract.status = ContractStatus.REJECTED.value
        contract.rejected_at = datetime.utcnow()
        contract.rejection_reason = rejection_reason
        reason_text = f' Причина: {rejection_reason}' if rejection_reason else ''
        add_request_history(db=db, request_id=contract.request_id, event_type='contract_rejected', description=f'Контракт отклонен заказчиком.{reason_text}', user_id=user_id, commit=False)
        try:
            notification = Notification(user_id=contract.carrier_id, type='contract_rejected', title='Контракт отклонен', message=f'Заказчик отклонил контракт для заявки №{contract.request_id}.{reason_text}', request_id=contract.request_id, is_read=False)
            db.add(notification)
        except Exception as e:
            print(f'Ошибка при создании уведомления: {e}')
        db.commit()
        db.refresh(contract)
        return {'success': True, 'message': 'Контракт отклонен', 'contract_id': contract.id, 'status': contract.status}
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f'Ошибка при отклонении контракта: {str(e)}')

@app.post('/api/contracts/{contract_id}/upload-document')
async def upload_contract_document(contract_id: int, document: UploadFile=File(...), db: Session=Depends(get_db), user_id: int=Depends(get_current_user_id)):
    """Загрузка договора заказчиком (после утверждения контракта)"""
    try:
        contract = db.query(Contract).filter(Contract.id == contract_id).first()
        if not contract:
            raise HTTPException(status_code=404, detail='Контракт не найден')
        if contract.customer_id != user_id:
            raise HTTPException(status_code=403, detail='Только заказчик может загрузить договор')
        if contract.status not in [ContractStatus.PENDING_APPROVAL.value, ContractStatus.APPROVED.value]:
            raise HTTPException(status_code=400, detail='Невозможно загрузить документ для контракта с текущим статусом')
        if contract.document_path:
            raise HTTPException(status_code=400, detail='Документ уже загружен')
        import os
        from pathlib import Path
        backend_dir = Path(__file__).parent
        contracts_dir = backend_dir / 'contracts'
        contracts_dir.mkdir(exist_ok=True)
        file_extension = Path(document.filename).suffix if document.filename else '.pdf'
        file_name = f'contract_{contract_id}_document{file_extension}'
        file_path = contracts_dir / file_name
        content = await document.read()
        with open(file_path, 'wb') as f:
            f.write(content)
        contract.document_path = str(file_path)
        contract.document_uploaded_at = datetime.utcnow()
        contract.status = ContractStatus.DOCUMENT_UPLOADED.value
        add_request_history(db=db, request_id=contract.request_id, event_type='contract_document_uploaded', description=f'Загружен пакет документов от заказчика: {document.filename}', user_id=user_id, commit=False)
        try:
            notification = Notification(user_id=contract.carrier_id, type='contract_document_uploaded', title='Договор загружен', message=f'Заказчик загрузил договор для заявки №{contract.request_id}. Требуется ваша подпись.', request_id=contract.request_id, is_read=False)
            db.add(notification)
        except Exception as e:
            print(f'Ошибка при создании уведомления: {e}')
        db.commit()
        db.refresh(contract)
        return {'success': True, 'message': 'Договор успешно загружен', 'contract_id': contract.id, 'document_path': contract.document_path, 'status': contract.status}
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f'Ошибка при загрузке договора: {str(e)}')

@app.get('/api/contracts/{contract_id}/sign-nonce')
async def get_contract_sign_nonce(contract_id: int, db: Session=Depends(get_db), user_id: int=Depends(get_current_user_id)):
    """Получение nonce для подписания документа контракта через ЭЦП"""
    try:
        contract = db.query(Contract).filter(Contract.id == contract_id).first()
        if not contract:
            raise HTTPException(status_code=404, detail='Контракт не найден')
        is_customer = contract.customer_id == user_id
        is_carrier = contract.carrier_id == user_id
        if not (is_customer or is_carrier):
            raise HTTPException(status_code=403, detail='Только заказчик или перевозчик могут подписать договор-заявку')
        if not contract.document_path:
            raise HTTPException(status_code=400, detail='Договор-заявка еще не создан. Сначала создайте договор-заявку.')
        import secrets
        import uuid
        nonce = f'contract_{contract_id}_{uuid.uuid4().hex}_{secrets.token_hex(16)}'
        expires_at = datetime.utcnow() + timedelta(minutes=10)
        used_nonce = UsedNonce(nonce=nonce, expires_at=expires_at, used_at=None)
        db.add(used_nonce)
        db.commit()
        return {'nonce': nonce, 'expires_at': expires_at.isoformat(), 'contract_id': contract_id}
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f'Ошибка при получении nonce: {str(e)}')

@app.post('/api/contracts/{contract_id}/verify-signature')
async def verify_contract_signature(contract_id: int, request: VerifyRequest, db: Session=Depends(get_db), user_id: int=Depends(get_current_user_id)):
    """Верификация подписи документа контракта через ЭЦП"""
    try:
        contract = db.query(Contract).filter(Contract.id == contract_id).first()
        if not contract:
            raise HTTPException(status_code=404, detail='Контракт не найден')
        is_customer = contract.customer_id == user_id
        is_carrier = contract.carrier_id == user_id
        if not (is_customer or is_carrier):
            raise HTTPException(status_code=403, detail='Только заказчик или перевозчик могут подписать договор-заявку')
        if not contract.document_path:
            raise HTTPException(status_code=400, detail='Договор-заявка еще не создан. Сначала создайте договор-заявку.')
        import json
        signatures_data = {}
        if contract.signature_cert_data:
            try:
                signatures_data = json.loads(contract.signature_cert_data)
            except:
                signatures_data = {'carrier': json.loads(contract.signature_cert_data)}
        customer_signed = 'customer' in signatures_data and signatures_data['customer'] is not None
        carrier_signed = 'carrier' in signatures_data and signatures_data['carrier'] is not None
        if is_customer and customer_signed:
            raise HTTPException(status_code=400, detail='Заказчик уже подписал договор-заявку')
        if is_carrier and carrier_signed:
            raise HTTPException(status_code=400, detail='Перевозчик уже подписал договор-заявку')
        from lxml import etree
        root = etree.fromstring(request.signedXml.encode('utf-8'))
        extracted_nonce = (root.text or '').strip()
        used_nonce = db.query(UsedNonce).filter(UsedNonce.nonce == extracted_nonce).first()
        if not used_nonce:
            raise HTTPException(status_code=400, detail='Неверный nonce')
        if used_nonce.used_at is not None:
            raise HTTPException(status_code=400, detail='Nonce уже использован')
        if used_nonce.expires_at < datetime.utcnow():
            raise HTTPException(status_code=400, detail='Nonce истек')
        x509_cert_elem = root.find('.//{http://www.w3.org/2000/09/xmldsig#}X509Certificate')
        if x509_cert_elem is None:
            raise HTTPException(status_code=400, detail='Сертификат не найден в подписи')
        cert_pem = x509_cert_elem.text
        cert_bytes = base64.b64decode(cert_pem)
        cert = x509.load_der_x509_certificate(cert_bytes, default_backend())
        subject = cert.subject
        issuer = cert.issuer
        iin = ''
        common_name = ''
        organization = ''
        email = ''
        for attr in subject:
            if attr.oid == x509.NameOID.COMMON_NAME:
                common_name = attr.value
            elif attr.oid == x509.NameOID.ORGANIZATION_NAME:
                organization = attr.value
            elif attr.oid == x509.NameOID.EMAIL_ADDRESS:
                email = attr.value
            oid_str = str(attr.oid)
            if '1.2.643.100.1' in oid_str or '1.2.398.3.3.1.1' in oid_str:
                iin = attr.value
        if not iin:
            for attr in subject:
                if attr.oid == x509.NameOID.SERIAL_NUMBER:
                    value = attr.value
                    if value.isdigit() and len(value) in [10, 12]:
                        iin = value
        cert_data = {'iin': iin, 'full_name': common_name, 'company_name': organization, 'email': email, 'serial_number': format(cert.serial_number, 'X'), 'issuer': issuer.rfc4514_string() if issuer else 'Неизвестный УЦ'}
        is_valid = verify_xml_signature(request.signedXml, extracted_nonce, CertificateData(**cert_data))
        if not is_valid:
            raise HTTPException(status_code=400, detail='Неверная подпись')
        signer = db.query(User).filter(User.id == user_id).first()
        if signer and signer.iin:
            signer_iin_clean = ''.join(filter(str.isdigit, str(signer.iin).strip()))
            cert_iin = cert_data.get('iin', '')
            if cert_iin:
                cert_iin_clean = ''.join(filter(str.isdigit, str(cert_iin).strip()))
                if signer_iin_clean and cert_iin_clean and (signer_iin_clean != cert_iin_clean):
                    print(f'Ошибка безопасности: ИИН не совпадают. Пользователь: {signer_iin_clean}, Сертификат: {cert_iin_clean}')
                    raise HTTPException(status_code=403, detail='Подпись должна быть выполнена вашим сертификатом. ИИН в сертификате не совпадает с вашим ИИН в системе.')
            else:
                print(f'Предупреждение: В сертификате нет ИИН, но у пользователя ИИН указан: {signer_iin_clean}')
        if is_customer:
            signatures_data['customer'] = cert_data
            signatures_data['customer_signed_at'] = datetime.utcnow().isoformat()
        if is_carrier:
            signatures_data['carrier'] = cert_data
            signatures_data['carrier_signed_at'] = datetime.utcnow().isoformat()
        contract.signature_cert_data = json.dumps(signatures_data, ensure_ascii=False)
        new_customer_signed = customer_signed or is_customer
        new_carrier_signed = carrier_signed or is_carrier
        both_signed = new_customer_signed and new_carrier_signed
        if both_signed:
            contract.status = ContractStatus.SIGNED.value
            contract.signed_at = datetime.utcnow()
            try:
                print(f'Договор-заявка подписан обеими сторонами. Доверенность будет доступна для генерации.')
            except Exception as e:
                print(f'Предупреждение: Не удалось подготовить генерацию доверенности: {e}')
        else:
            contract.status = ContractStatus.APPROVED.value
        used_nonce.used_at = datetime.utcnow()
        if both_signed and contract.document_path:
            try:
                customer_name = signatures_data.get('customer', {}).get('full_name', 'Не указан') if 'customer' in signatures_data else 'Не подписан'
                carrier_name = signatures_data.get('carrier', {}).get('full_name', 'Не указан') if 'carrier' in signatures_data else 'Не подписан'
                print(f'Создание подписанного PDF для контракта {contract.id}, оригинальный путь: {contract.document_path}')
                signed_pdf_path = await create_signed_pdf_with_qr(contract_id=contract.id, original_pdf_path=contract.document_path, signer_name=f'{customer_name} (заказчик), {carrier_name} (перевозчик)', signer_iin=cert_data.get('iin', ''), signed_at=contract.signed_at)
                print(f'Подписанный PDF создан: {signed_pdf_path}')
                contract.signed_document_path = signed_pdf_path
                print(f'Путь сохранен в контракт: {contract.signed_document_path}')
            except Exception as e:
                import traceback
                error_details = traceback.format_exc()
                print(f'ОШИБКА при создании подписанного PDF: {e}')
                print(f'Детали ошибки: {error_details}')
        signer_role = 'заказчиком' if is_customer else 'перевозчиком'
        add_request_history(db=db, request_id=contract.request_id, event_type='contract_signed', description=f'Договор-заявка подписан {signer_role} через ЭЦП', user_id=user_id, metadata={'signer_name': cert_data.get('full_name'), 'signer_iin': cert_data.get('iin'), 'signer_role': 'customer' if is_customer else 'carrier'}, commit=False)
        try:
            if both_signed:
                notification_customer = Notification(user_id=contract.customer_id, type='contract_signed', title='Договор-заявка подписан обеими сторонами', message=f'Договор-заявка для заявки №{contract.request_id} подписан обеими сторонами. Теперь можно сгенерировать доверенность.', request_id=contract.request_id, is_read=False)
                db.add(notification_customer)
                notification_carrier = Notification(user_id=contract.carrier_id, type='contract_signed', title='Договор-заявка подписан обеими сторонами', message=f'Договор-заявка для заявки №{contract.request_id} подписан обеими сторонами. Теперь можно сгенерировать доверенность.', request_id=contract.request_id, is_read=False)
                db.add(notification_carrier)
            else:
                other_user_id = contract.customer_id if is_carrier else contract.carrier_id
                other_role = 'заказчик' if is_carrier else 'перевозчик'
                notification = Notification(user_id=other_user_id, type='contract_signed', title='Договор-заявка подписан', message=f'{other_role.capitalize()} подписал договор-заявку для заявки №{contract.request_id} через ЭЦП. Требуется ваша подпись.', request_id=contract.request_id, is_read=False)
            db.add(notification)
        except Exception as e:
            print(f'Ошибка при создании уведомления: {e}')
        db.commit()
        db.refresh(contract)
        print(f'Контракт обновлен после подписания. signed_document_path: {contract.signed_document_path}')
        message = 'Договор-заявка успешно подписан через ЭЦП'
        if both_signed:
            message = 'Договор-заявка подписан обеими сторонами. Теперь можно сгенерировать доверенность.'
        return {'success': True, 'message': message, 'contract_id': contract.id, 'status': contract.status, 'signed_at': contract.signed_at.isoformat() if contract.signed_at else None, 'signer': cert_data.get('full_name'), 'signed_document_path': contract.signed_document_path, 'both_signed': both_signed}
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f'Ошибка при верификации подписи: {str(e)}')

async def create_signed_pdf_with_qr(contract_id: int, original_pdf_path: str, signer_name: str, signer_iin: str, signed_at: datetime, *, document_kind: str='contract') -> str:
    """Создает подписанный PDF с визуальной подписью и QR-кодом используя WeasyPrint.

    document_kind:
      - "contract" — договор-заявка: contracts/signed/contract_{id}_signed.pdf
      - "power_of_attorney" — доверенность: contracts/power_of_attorney/power_of_attorney_{id}_signed.pdf
      - "act" — акт: contracts/signed/act_{id}_signed.pdf (id = request_id в вызове)

    Раньше все виды писались в contract_{id}_signed.pdf, из‑за чего подписание доверенности
    перезаписывало подписанный договор.
    """
    from pathlib import Path
    from PyPDF2 import PdfReader, PdfWriter
    import qrcode
    from io import BytesIO
    import json
    import os
    import base64
    from jinja2 import Template
    print(f'[create_signed_pdf_with_qr] Начало создания PDF для контракта {contract_id}, kind={document_kind}')
    print(f'[create_signed_pdf_with_qr] Оригинальный путь: {original_pdf_path}')
    backend_dir = Path(__file__).parent
    if document_kind == 'power_of_attorney':
        signed_dir = backend_dir / 'contracts' / 'power_of_attorney'
        signed_filename = f'power_of_attorney_{contract_id}_signed.pdf'
        qr_type = 'power_of_attorney_signature'
    elif document_kind == 'act':
        signed_dir = backend_dir / 'contracts' / 'signed'
        signed_filename = f'act_{contract_id}_signed.pdf'
        qr_type = 'act_signature'
    else:
        signed_dir = backend_dir / 'contracts' / 'signed'
        signed_filename = f'contract_{contract_id}_signed.pdf'
        qr_type = 'contract_signature'
    signed_dir.mkdir(parents=True, exist_ok=True)
    print(f'[create_signed_pdf_with_qr] Директория: {signed_dir}, файл: {signed_filename}')
    original_path = Path(original_pdf_path)
    if not original_path.is_absolute():
        original_path = Path.cwd() / original_pdf_path
    if not original_path.exists():
        backend_path = Path(__file__).parent / original_pdf_path
        if backend_path.exists():
            original_path = backend_path
        else:
            raise FileNotFoundError(f'Оригинальный документ не найден: {original_pdf_path}')
    print(f'[create_signed_pdf_with_qr] Файл найден, размер: {original_path.stat().st_size} байт')
    qr_data = {'contract_id': contract_id, 'signer_name': signer_name, 'signer_iin': signer_iin, 'signed_at': signed_at.isoformat(), 'type': qr_type}
    qr_data_str = json.dumps(qr_data, ensure_ascii=False)
    import hashlib
    vf = hashlib.sha256(qr_data_str.encode('utf-8')).hexdigest()
    verification_fingerprint = ' '.join((vf[i:i + 8] for i in range(0, len(vf), 8)))
    kind_abbr = {'contract': 'DG', 'power_of_attorney': 'POA', 'act': 'ACT'}.get(document_kind, 'DOC')
    registry_sheet_no = f'ЭЦП-CA-{kind_abbr}-{contract_id:08d}'
    transaction_id = f'CA-TX-{kind_abbr}-{contract_id:08d}-{vf[:10].upper()}'
    system_id = 'CARGOATIU-EDS-KZ-1'
    qr_record_type_label = {'contract_signature': 'Подпись договора-заявки', 'power_of_attorney_signature': 'Подпись доверенности', 'act_signature': 'Подпись акта'}.get(qr_type, qr_type)
    qr = qrcode.QRCode(version=1, box_size=10, border=4)
    qr.add_data(qr_data_str)
    qr.make(fit=True)
    qr_img = qr.make_image(fill_color='black', back_color='white')
    qr_buffer = BytesIO()
    qr_img.save(qr_buffer, format='PNG')
    qr_buffer.seek(0)
    qr_base64 = base64.b64encode(qr_buffer.getvalue()).decode('utf-8')
    qr_data_uri = f'data:image/png;base64,{qr_base64}'
    qr_buffer.close()
    template_path = backend_dir / 'templates' / 'signature_page.html'
    if not template_path.exists():
        raise FileNotFoundError(f'Шаблон не найден: {template_path}')
    with open(template_path, 'r', encoding='utf-8') as f:
        template_content = f.read()
    template = Template(template_content)
    signed_date_str = signed_at.strftime('%d.%m.%Y %H:%M:%S')
    document_type_label = {'contract': 'Договор-заявка (электронная форма)', 'power_of_attorney': 'Доверенность (электронная форма)', 'act': 'Акт (электронная форма)'}.get(document_kind, 'Электронный документ')
    html_content = template.render(signer_name=signer_name, signer_iin=signer_iin, signed_date=signed_date_str, qr_code_data_uri=qr_data_uri, document_type_label=document_type_label, internal_document_id=str(contract_id), platform_name='CargoAitu', registry_sheet_no=registry_sheet_no, document_id=registry_sheet_no, document_hash=vf, transaction_id=transaction_id, system_id=system_id, verification_fingerprint=verification_fingerprint, qr_record_type_label=qr_record_type_label)
    try:
        from weasyprint import HTML
        if os.path.exists('/opt/homebrew/lib'):
            os.environ['DYLD_LIBRARY_PATH'] = '/opt/homebrew/lib'
        elif os.path.exists('/usr/local/lib'):
            os.environ['DYLD_LIBRARY_PATH'] = '/usr/local/lib'
        signature_buffer = BytesIO()
        html_doc = HTML(string=html_content, base_url=str(backend_dir))
        html_doc.write_pdf(signature_buffer)
        signature_buffer.seek(0)
        print(f'[create_signed_pdf_with_qr] Страница подписи сгенерирована, размер: {len(signature_buffer.getvalue())} байт')
    except ImportError:
        raise Exception('Библиотека weasyprint не установлена. Установите: pip install weasyprint')
    except Exception as e:
        import traceback
        error_details = traceback.format_exc()
        print(f'[create_signed_pdf_with_qr] Ошибка генерации PDF: {error_details}')
        raise Exception(f'Ошибка генерации PDF страницы подписи: {str(e)}')
    original_reader = PdfReader(str(original_path))
    signature_reader = PdfReader(signature_buffer)
    writer = PdfWriter()
    for page in original_reader.pages:
        writer.add_page(page)
    writer.add_page(signature_reader.pages[0])
    signed_path = signed_dir / signed_filename
    print(f'[create_signed_pdf_with_qr] Сохранение подписанного PDF: {signed_path}')
    with open(signed_path, 'wb') as output_file:
        writer.write(output_file)
    print(f'[create_signed_pdf_with_qr] PDF сохранен, размер: {signed_path.stat().st_size} байт')
    rel_from_backend = signed_path.relative_to(backend_dir)
    return str(rel_from_backend).replace('\\', '/')

@app.get('/api/contracts/{contract_id}/generate-power-of-attorney')
async def generate_power_of_attorney(contract_id: int, db: Session=Depends(get_db), user_id: int=Depends(get_current_user_id)):
    """Генерация доверенности для контракта"""
    try:
        contract = db.query(Contract).filter(Contract.id == contract_id).first()
        if not contract:
            raise HTTPException(status_code=404, detail='Контракт не найден')
        if contract.carrier_id != user_id:
            raise HTTPException(status_code=403, detail='Только перевозчик может генерировать доверенность')
        import json
        signatures_data = {}
        if contract.signature_cert_data:
            try:
                signatures_data = json.loads(contract.signature_cert_data)
            except:
                signatures_data = {'carrier': json.loads(contract.signature_cert_data)}
        customer_signed = 'customer' in signatures_data and signatures_data['customer'] is not None
        carrier_signed = 'carrier' in signatures_data and signatures_data['carrier'] is not None
        if not (customer_signed and carrier_signed):
            raise HTTPException(status_code=400, detail='Доверенность можно сгенерировать только после подписания договора-заявки обеими сторонами')
        if contract.status != ContractStatus.SIGNED.value:
            raise HTTPException(status_code=400, detail='Договор-заявка должен быть подписан обеими сторонами перед генерацией доверенности')
        request = db.query(Request).filter(Request.id == contract.request_id).first()
        if not request:
            raise HTTPException(status_code=404, detail='Заявка не найдена')
        carrier = db.query(User).filter(User.id == contract.carrier_id).first()
        if not carrier:
            raise HTTPException(status_code=404, detail='Перевозчик не найден')
        customer = db.query(User).filter(User.id == contract.customer_id).first()
        if not customer:
            raise HTTPException(status_code=404, detail='Заказчик не найден')
        driver = db.query(Driver).filter(Driver.id == contract.driver_id).first()
        if not driver:
            raise HTTPException(status_code=404, detail='Водитель не найден')
        vehicle = db.query(Vehicle).filter(Vehicle.id == contract.vehicle_id).first()
        if not vehicle:
            raise HTTPException(status_code=404, detail='Машина не найдена')
        if not all([request, carrier, customer, driver, vehicle]):
            raise HTTPException(status_code=404, detail='Не удалось загрузить данные')
        issue_date = datetime.utcnow()
        valid_until = issue_date + timedelta(days=10)
        months_ru_long = ('', 'января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря')

        def _poa_date_ru_long(dt):
            if not dt:
                return ''
            return f'«{dt.day}» {months_ru_long[dt.month]} {dt.year} г.'

        def _poa_date_ru(dt):
            if not dt:
                return ''
            return dt.strftime('%d.%m.%Y')
        issue_date_long = _poa_date_ru_long(issue_date)
        valid_until_long = _poa_date_ru_long(valid_until)
        request_date_long = _poa_date_ru_long(request.created_at) if request.created_at else ''
        contract_ref_dt = contract.signed_at or contract.created_at
        carriage_contract_date_long = _poa_date_ru_long(contract_ref_dt) if contract_ref_dt else ''
        driver_passport = ''
        passport_parts = []
        if driver.passport_series:
            passport_parts.append(driver.passport_series)
        if driver.passport_number:
            passport_parts.append(driver.passport_number)
        if passport_parts:
            driver_passport = ' '.join(passport_parts)
            if driver.passport_issued_by:
                driver_passport += f', выдан {driver.passport_issued_by}'
            if driver.passport_issue_date:
                driver_passport += f" {driver.passport_issue_date.strftime('%d.%m.%Y')}"
        if not driver_passport:
            driver_passport = 'Не указан'
        driver_license = ''
        if driver.license_series and driver.license_number:
            driver_license = f'{driver.license_series}-{driver.license_number}'
            if driver.license_issue_date:
                driver_license += f", выдано {driver.license_issue_date.strftime('%d.%m.%Y')}"
        vehicle_parts = []
        if vehicle.tractor_brand and vehicle.tractor_license_plate:
            vehicle_parts.append(f'Тягач {vehicle.tractor_brand} {vehicle.tractor_license_plate}')
        if vehicle.trailer_brand and vehicle.trailer_license_plate:
            vehicle_parts.append(f'Полуприцеп {vehicle.trailer_brand} {vehicle.trailer_license_plate}')
        vehicle_info = ', '.join(vehicle_parts)
        if vehicle.tonnage and vehicle.volume:
            vehicle_info += f', {vehicle.tonnage}т/{vehicle.volume}м³'
        if vehicle.body_type:
            vehicle_info += f', {vehicle.body_type}'
        name_parts = carrier.full_name.split()
        carrier_manager_name = f"{name_parts[0]} {''.join((n[0] + '.' for n in name_parts[1:]))}" if len(name_parts) > 1 else carrier.full_name
        carrier_display_name = carrier.company_name or carrier.full_name or '—'
        bin_iin_parts = [x for x in [(carrier.bin or '').strip(), (carrier.iin or '').strip()] if x]
        carrier_bin_iin = ' / '.join(bin_iin_parts) if bin_iin_parts else '—'
        carrier_legal_address = (carrier.address or '').strip() or '—'
        carrier_actual_address = (carrier.address or '').strip() or '—'
        carrier_representative = (carrier.director_name or '').strip() or (carrier.full_name or '—')
        carrier_signatory_name = (carrier.director_name or '').strip() or (carrier.full_name or '—')
        carrier_acting_basis = 'Устава'
        driver_birth_date_str = _poa_date_ru(driver.birth_date) if driver.birth_date else ''
        driver_iin_val = (driver.inn or '').strip() or '—'
        passport_num_parts = [x for x in [driver.passport_series or '', driver.passport_number or ''] if x]
        driver_passport_number_line = ' '.join(passport_num_parts).strip() or '—'
        _pp_issued = []
        if driver.passport_issued_by:
            _pp_issued.append(driver.passport_issued_by.strip())
        if driver.passport_issue_date:
            _pp_issued.append(driver.passport_issue_date.strftime('%d.%m.%Y'))
        driver_passport_issued_detail = ', '.join(_pp_issued) if _pp_issued else '—'
        driver_license_issue_str = driver.license_issue_date.strftime('%d.%m.%Y') if driver.license_issue_date else ''
        tractor_bm = (vehicle.tractor_brand or '').strip() or '—'
        tractor_plate = (vehicle.tractor_license_plate or '').strip() or '—'
        trailer_bm = (vehicle.trailer_brand or '').strip() or '—'
        trailer_plate = (vehicle.trailer_license_plate or '').strip() or '—'
        vehicle_tonnage_str = f'{vehicle.tonnage:g} т' if vehicle.tonnage is not None else ''
        vehicle_body_type_str = (vehicle.body_type or '').strip()
        cargo_name_str = (request.cargo_type or '').strip() or '—'
        cargo_weight_str = f'{request.cargo_weight:g}' if request.cargo_weight is not None else ''
        backend_dir = Path(__file__).parent
        template_path = Path('templates') / 'power_of_attorney.html'
        if not template_path.exists():
            template_path = backend_dir / 'templates' / 'power_of_attorney.html'
        if not template_path.exists():
            raise HTTPException(status_code=500, detail='Шаблон доверенности не найден')
        template = Template(template_path.read_text(encoding='utf-8'))
        print(f'[generate_power_of_attorney] Водитель ID: {driver.id}')
        print(f'[generate_power_of_attorney] Сформированный паспорт: {driver_passport}')
        print(f'[generate_power_of_attorney] В/У: {driver_license}')
        html_content = template.render(platform_name='AituCargo', power_of_attorney_number=contract.id, issue_city='', issue_date_long=issue_date_long, carrier_name=carrier_display_name, carrier_org_form='', carrier_bin_iin=carrier_bin_iin, carrier_legal_address=carrier_legal_address, carrier_actual_address=carrier_actual_address, carrier_representative=carrier_representative, carrier_acting_basis=carrier_acting_basis, carrier_signatory_name=carrier_signatory_name, carrier_manager_name=carrier_manager_name, request_number=str(request.id), request_date=_poa_date_ru(request.created_at) if request.created_at else '', request_date_long=request_date_long, carriage_contract_number=str(request.id), carriage_contract_date_long=carriage_contract_date_long or issue_date_long, driver_full_name=driver.full_name, driver_birth_date=driver_birth_date_str, driver_iin=driver_iin_val, driver_passport_number_line=driver_passport_number_line, driver_passport_issued=driver_passport_issued_detail, driver_license_series=driver.license_series or '', driver_license_number=driver.license_number or '', driver_license_category=(driver.license_type or '').strip(), driver_license_issue_date=driver_license_issue_str, driver_phone=driver.phone or '', tractor_brand_model=tractor_bm, tractor_plate=tractor_plate, trailer_brand_model=trailer_bm, trailer_plate=trailer_plate, vehicle_tonnage=vehicle_tonnage_str, vehicle_body_type=vehicle_body_type_str, route=f'{request.from_city} → {request.to_city}', cargo_name=cargo_name_str, cargo_weight=cargo_weight_str, cargo_unit='т', valid_until_long=valid_until_long)
        try:
            from weasyprint import HTML
            from io import BytesIO
            import os
            if os.path.exists('/opt/homebrew/lib'):
                os.environ['DYLD_LIBRARY_PATH'] = '/opt/homebrew/lib'
            elif os.path.exists('/usr/local/lib'):
                os.environ['DYLD_LIBRARY_PATH'] = '/usr/local/lib'
            pdf_buffer = BytesIO()
            html_doc = HTML(string=html_content, base_url=str(backend_dir))
            html_doc.write_pdf(pdf_buffer)
            pdf_bytes = pdf_buffer.getvalue()
            pdf_buffer.close()
            if not pdf_bytes or len(pdf_bytes) == 0:
                raise Exception('PDF файл пуст или не был создан')
        except ImportError:
            raise HTTPException(status_code=500, detail='Библиотека weasyprint не установлена. Установите: pip install weasyprint')
        except Exception as e:
            import traceback
            error_details = traceback.format_exc()
            print(f'Ошибка генерации PDF: {error_details}')
            raise HTTPException(status_code=500, detail=f'Ошибка генерации PDF: {str(e)}')
        power_of_attorney_dir = backend_dir / 'contracts' / 'power_of_attorney'
        power_of_attorney_dir.mkdir(parents=True, exist_ok=True)
        filename_safe = f'power_of_attorney_{contract.id}.pdf'
        file_path = power_of_attorney_dir / filename_safe
        with open(file_path, 'wb') as f:
            f.write(pdf_bytes)
        relative_path = f'contracts/power_of_attorney/{filename_safe}'
        contract.power_of_attorney_path = relative_path
        db.commit()
        filename_display = f'Доверенность_{contract.id}.pdf'
        import urllib.parse
        filename_encoded = urllib.parse.quote(filename_display.encode('utf-8'))
        return Response(content=pdf_bytes, media_type='application/pdf', headers={'Content-Disposition': f"""attachment; filename="{filename_safe}"; filename*=UTF-8''{filename_encoded}""", 'Content-Type': 'application/pdf', 'X-Content-Type-Options': 'nosniff'})
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f'Ошибка при генерации доверенности: {str(e)}')

@app.get('/api/contracts/{contract_id}/power-of-attorney/sign-nonce')
async def get_power_of_attorney_sign_nonce(contract_id: int, db: Session=Depends(get_db), user_id: int=Depends(get_current_user_id)):
    """Получение nonce для подписания доверенности через ЭЦП"""
    try:
        contract = db.query(Contract).filter(Contract.id == contract_id).first()
        if not contract:
            raise HTTPException(status_code=404, detail='Контракт не найден')
        if contract.carrier_id != user_id:
            raise HTTPException(status_code=403, detail='Только перевозчик может подписать доверенность')
        if not contract.power_of_attorney_path:
            raise HTTPException(status_code=400, detail='Доверенность еще не создана. Сначала сгенерируйте доверенность.')
        if contract.power_of_attorney_signature_xml:
            raise HTTPException(status_code=400, detail='Доверенность уже подписана')
        import secrets
        import uuid
        nonce = str(uuid.uuid4())
        from datetime import timedelta
        expires_at = datetime.utcnow() + timedelta(minutes=10)
        used_nonce = UsedNonce(nonce=nonce, expires_at=expires_at, used_at=None)
        db.add(used_nonce)
        db.commit()
        return {'nonce': nonce, 'expiresAt': expires_at.isoformat()}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f'Ошибка при генерации nonce: {str(e)}')

@app.post('/api/contracts/{contract_id}/power-of-attorney/verify-signature')
async def verify_power_of_attorney_signature(contract_id: int, request: VerifyRequest, db: Session=Depends(get_db), user_id: int=Depends(get_current_user_id)):
    """Верификация подписи доверенности через ЭЦП"""
    try:
        contract = db.query(Contract).filter(Contract.id == contract_id).first()
        if not contract:
            raise HTTPException(status_code=404, detail='Контракт не найден')
        if contract.carrier_id != user_id:
            raise HTTPException(status_code=403, detail='Только перевозчик может подписать доверенность')
        if not contract.power_of_attorney_path:
            raise HTTPException(status_code=400, detail='Доверенность еще не создана. Сначала сгенерируйте доверенность.')
        if contract.power_of_attorney_signature_xml:
            raise HTTPException(status_code=400, detail='Доверенность уже подписана')
        from lxml import etree
        root = etree.fromstring(request.signedXml.encode('utf-8'))
        extracted_nonce = (root.text or '').strip()
        used_nonce = db.query(UsedNonce).filter(UsedNonce.nonce == extracted_nonce).first()
        if not used_nonce:
            raise HTTPException(status_code=400, detail='Неверный nonce')
        if used_nonce.used_at is not None:
            raise HTTPException(status_code=400, detail='Nonce уже использован')
        if used_nonce.expires_at < datetime.utcnow():
            raise HTTPException(status_code=400, detail='Nonce истек')
        x509_cert_elem = root.find('.//{http://www.w3.org/2000/09/xmldsig#}X509Certificate')
        if x509_cert_elem is None:
            raise HTTPException(status_code=400, detail='Сертификат не найден в подписи')
        cert_pem = x509_cert_elem.text
        cert_bytes = base64.b64decode(cert_pem)
        cert = x509.load_der_x509_certificate(cert_bytes, default_backend())
        subject = cert.subject
        issuer = cert.issuer
        iin = ''
        common_name = ''
        organization = ''
        email = ''
        for attr in subject:
            if attr.oid == x509.NameOID.COMMON_NAME:
                common_name = attr.value
            elif attr.oid == x509.NameOID.ORGANIZATION_NAME:
                organization = attr.value
            elif attr.oid == x509.NameOID.EMAIL_ADDRESS:
                email = attr.value
            oid_str = str(attr.oid)
            if '1.2.643.100.1' in oid_str or '1.2.398.3.3.1.1' in oid_str:
                iin = attr.value
        if not iin:
            for attr in subject:
                if attr.oid == x509.NameOID.SERIAL_NUMBER:
                    value = attr.value
                    if value.isdigit() and len(value) in [10, 12]:
                        iin = value
        cert_data = {'iin': iin, 'full_name': common_name, 'company_name': organization, 'email': email, 'serial_number': format(cert.serial_number, 'X'), 'issuer': issuer.rfc4514_string() if issuer else 'Неизвестный УЦ'}
        is_valid = verify_xml_signature(request.signedXml, extracted_nonce, CertificateData(**cert_data))
        if not is_valid:
            raise HTTPException(status_code=400, detail='Неверная подпись')
        signer = db.query(User).filter(User.id == user_id).first()
        if signer and signer.iin:
            signer_iin_clean = ''.join(filter(str.isdigit, str(signer.iin).strip()))
            cert_iin = cert_data.get('iin', '')
            if cert_iin:
                cert_iin_clean = ''.join(filter(str.isdigit, str(cert_iin).strip()))
                if signer_iin_clean and cert_iin_clean and (signer_iin_clean != cert_iin_clean):
                    print(f'Ошибка безопасности: ИИН не совпадают. Пользователь: {signer_iin_clean}, Сертификат: {cert_iin_clean}')
                    raise HTTPException(status_code=403, detail='Подпись должна быть выполнена вашим сертификатом. ИИН в сертификате не совпадает с вашим ИИН в системе.')
        contract.power_of_attorney_signature_xml = request.signedXml
        contract.power_of_attorney_signature_cert_data = json.dumps(cert_data, ensure_ascii=False)
        if contract.power_of_attorney_path:
            try:
                carrier_name = cert_data.get('full_name', 'Не указан')
                print(f'Создание подписанного PDF для доверенности контракта {contract.id}, оригинальный путь: {contract.power_of_attorney_path}')
                signed_pdf_path = await create_signed_pdf_with_qr(contract_id=contract.id, original_pdf_path=contract.power_of_attorney_path, signer_name=carrier_name, signer_iin=cert_data.get('iin', ''), signed_at=datetime.utcnow(), document_kind='power_of_attorney')
                print(f'Подписанный PDF доверенности создан: {signed_pdf_path}')
                contract.signed_power_of_attorney_path = signed_pdf_path
                print(f'Путь сохранен в контракт: {contract.signed_power_of_attorney_path}')
            except Exception as e:
                import traceback
                error_details = traceback.format_exc()
                print(f'ОШИБКА при создании подписанного PDF доверенности: {e}')
                print(f'Детали ошибки: {error_details}')
        used_nonce.used_at = datetime.utcnow()
        db.commit()
        return {'success': True, 'message': 'Доверенность успешно подписана', 'signed_at': datetime.utcnow().isoformat()}
    except HTTPException:
        raise
    except Exception as e:
        import traceback
        error_details = traceback.format_exc()
        print(f'Ошибка при верификации подписи доверенности: {error_details}')
        raise HTTPException(status_code=500, detail=f'Ошибка при верификации подписи: {str(e)}')

@app.get('/api/contracts/{file_path:path}')
@app.get('/contracts/{file_path:path}')
async def get_contract_document(file_path: str, db: Session=Depends(get_db), user_id: int=Depends(get_current_user_id)):
    """Получение документа контракта (включая подписанные документы)"""
    from pathlib import Path
    backend_dir = Path(__file__).parent
    contracts_root = backend_dir / 'contracts'

    def _resolve_under_contracts(candidate: str) -> Path:
        candidate_str = str(candidate).replace('\\', '/').lstrip('/')
        if candidate_str.startswith('contracts/'):
            candidate_str = candidate_str[len('contracts/'):]
        candidate_path = Path(candidate_str)
        if candidate_path.is_absolute():
            return candidate_path
        return contracts_root / candidate_str

    request_obj, contract_obj, document_kind = _resolve_document_request_context(file_path, db)
    if not request_obj and not contract_obj:
        raise HTTPException(status_code=404, detail='Документ не найден')
    if request_obj and not _user_can_access_request_documents(user_id, request_obj):
        raise HTTPException(status_code=404, detail='Документ не найден')
    if contract_obj and not _user_can_access_request_documents(user_id, request_obj or db.query(Request).filter(Request.id == contract_obj.request_id).first()):
        raise HTTPException(status_code=404, detail='Документ не найден')
    file_full_path = _resolve_under_contracts(file_path)
    if not file_full_path.exists() or not file_full_path.is_file():
        fallback_paths: list[Optional[str]] = []
        if document_kind == 'contract' and contract_obj:
            fallback_paths = [contract_obj.signed_document_path, contract_obj.document_path]
        elif document_kind == 'power_of_attorney' and contract_obj:
            fallback_paths = [getattr(contract_obj, 'signed_power_of_attorney_path', None), getattr(contract_obj, 'power_of_attorney_path', None)]
        elif document_kind == 'act' and request_obj:
            fallback_paths = [request_obj.signed_act_path, request_obj.act_path]
        elif document_kind == 'invoice' and request_obj:
            fallback_paths = [request_obj.invoice_path]

        for candidate in fallback_paths:
            if not candidate:
                continue
            candidate_path = _resolve_under_contracts(candidate)
            if candidate_path.exists() and candidate_path.is_file():
                file_full_path = candidate_path
                break

    if not file_full_path.exists() or not file_full_path.is_file():
        raise HTTPException(status_code=404, detail='Документ не найден')
    contracts_dir = contracts_root.resolve()
    file_resolved = file_full_path.resolve()
    if not str(file_resolved).startswith(str(contracts_dir)):
        raise HTTPException(status_code=403, detail='Доступ запрещен')
    resolved_name = file_full_path.name
    return FileResponse(path=str(file_full_path), filename=resolved_name, media_type='application/pdf' if resolved_name.endswith('.pdf') else 'application/octet-stream')

class ChatMessage(BaseModel):
    message: str
    user_context: Optional[dict] = None

@app.get('/api/requests/{request_id}/generate-act')
async def generate_act(request_id: int, db: Session=Depends(get_db), user_id: int=Depends(get_current_user_id)):
    """Генерация акта выполненных работ"""
    try:
        request = db.query(Request).filter(Request.id == request_id).first()
        if not request:
            raise HTTPException(status_code=404, detail='Заявка не найдена')
        if request.selected_carrier_id != user_id:
            raise HTTPException(status_code=403, detail='Только перевозчик может создать акт')
        if request.status != RequestStatus.IN_PROGRESS.value:
            raise HTTPException(status_code=400, detail="Акт можно создать только для заявки в статусе 'В работе'")
        contract = db.query(Contract).filter(Contract.request_id == request_id).first()
        if not contract:
            raise HTTPException(status_code=404, detail='Контракт не найден')
        import json
        signatures_data = {}
        if contract.signature_cert_data:
            try:
                signatures_data = json.loads(contract.signature_cert_data)
            except:
                pass
        customer_signed = 'customer' in signatures_data and signatures_data['customer'] is not None
        carrier_signed = 'carrier' in signatures_data and signatures_data['carrier'] is not None
        if not (customer_signed and carrier_signed):
            raise HTTPException(status_code=400, detail='Акт можно создать только после подписания договора-заявки обеими сторонами')
        if request.act_path:
            raise HTTPException(status_code=400, detail='Акт уже создан')
        from sqlalchemy.orm import joinedload
        request = db.query(Request).options(joinedload(Request.customer), joinedload(Request.selected_carrier), joinedload(Request.assigned_driver), joinedload(Request.assigned_vehicle), joinedload(Request.selected_bid)).filter(Request.id == request_id).first()
        customer = request.customer
        carrier = request.selected_carrier
        driver = request.assigned_driver
        vehicle = request.assigned_vehicle
        selected_bid = request.selected_bid
        if not customer or not carrier:
            raise HTTPException(status_code=404, detail='Не удалось загрузить данные заказчика или перевозчика')
        contract_number = str(contract.id)
        contract_date = contract.created_at.strftime('%d.%m.%Y') if contract.created_at else datetime.utcnow().strftime('%d.%m.%Y')
        act_number = f"АВР-{request.id}-{datetime.utcnow().strftime('%Y%m%d')}"
        act_date = datetime.utcnow().strftime('%d.%m.%Y')
        loading_date = request.loading_date.strftime('%d.%m.%Y') if request.loading_date else ''
        loading_time = request.loading_date.strftime('%H:%M') if request.loading_date else ''
        delivery_date = request.delivery_date.strftime('%d.%m.%Y') if request.delivery_date else ''
        delivery_time = request.delivery_date.strftime('%H:%M') if request.delivery_date else ''
        price = selected_bid.price if selected_bid else request.max_price or 0
        price_fmt = f'{price:,.0f}'.replace(',', ' ') if price else '0'

        def _act_detail_line(user: User) -> str:
            parts = [(user.company_name or user.full_name or '').strip(), (user.address or '').strip(), (user.phone or '').strip(), (user.email or '').strip()]
            return ', '.join((p for p in parts if p)) or '—'

        def _act_bin_iin(user: User) -> str:
            b = (user.bin or '').strip()
            i = (user.iin or '').strip()
            if b and i:
                return f'{b} / {i}'
            return b or i or '—'

        def _act_signatory_short(user: User) -> str:
            name = (user.director_name or user.full_name or '').strip()
            if not name:
                return '—'
            parts = name.split()
            if len(parts) >= 2:
                return f"{parts[0]} {' '.join((p[0] + '.' for p in parts[1:] if p))}"
            return name
        customer_detail = _act_detail_line(customer)
        carrier_detail = _act_detail_line(carrier)
        service_description = f"Услуги по перевозке груза автомобильным транспортом: {request.cargo_type or 'груз'}; маршрут {request.from_city} — {request.to_city}; погрузка {loading_date} {loading_time}, выгрузка {delivery_date} {delivery_time}."
        service_completion_date = delivery_date or act_date
        jinja_env = get_jinja_env()
        template = jinja_env.get_template('act.html')
        backend_dir = Path(__file__).parent
        html_content = template.render(platform_name='AituCargo', act_number=act_number, act_date=act_date, contract_number=contract_number, contract_date=contract_date, contract_ref_line=f'Договор перевозки груза № {request.id} от {contract_date}', customer_company=customer.company_name or customer.full_name, customer_inn=customer.iin or '', customer_kpp=getattr(customer, 'kpp', None), customer_bin_iin=_act_bin_iin(customer), customer_detail_line=customer_detail, customer_position=getattr(customer, 'director_name', None) and 'Руководитель' or 'Директор', customer_signatory=_act_signatory_short(customer), carrier_company=carrier.company_name or carrier.full_name, carrier_inn=carrier.iin or '', carrier_kpp=getattr(carrier, 'kpp', None), carrier_bin_iin=_act_bin_iin(carrier), carrier_detail_line=carrier_detail, carrier_position=getattr(carrier, 'director_name', None) and 'Руководитель' or 'Директор', carrier_signatory=_act_signatory_short(carrier), from_city=request.from_city, to_city=request.to_city, loading_date=loading_date, loading_time=loading_time, delivery_date=delivery_date, delivery_time=delivery_time, cargo_name=request.cargo_type or 'Груз', cargo_weight=request.cargo_weight, cargo_volume=request.cargo_volume, service_description=service_description, service_completion_date=service_completion_date, unit_measure='усл.', quantity='1', unit_price=price_fmt, line_amount=price_fmt, vat_rate_label='без НДС', vat_amount='—', inventory_line='нет', appendix_pages='___', price=price_fmt, currency='KZT', price_no_vat=True)
        from weasyprint import HTML
        from io import BytesIO
        import os
        if os.path.exists('/opt/homebrew/lib'):
            os.environ['DYLD_LIBRARY_PATH'] = '/opt/homebrew/lib'
        elif os.path.exists('/usr/local/lib'):
            os.environ['DYLD_LIBRARY_PATH'] = '/usr/local/lib'
        pdf_buffer = BytesIO()
        html_doc = HTML(string=html_content, base_url=str(backend_dir))
        html_doc.write_pdf(pdf_buffer)
        pdf_bytes = pdf_buffer.getvalue()
        pdf_buffer.close()
        acts_dir = backend_dir / 'contracts' / 'acts'
        acts_dir.mkdir(parents=True, exist_ok=True)
        filename = f"act_{request_id}_{datetime.utcnow().strftime('%Y%m%d_%H%M%S')}.pdf"
        file_path = acts_dir / filename
        with open(file_path, 'wb') as f:
            f.write(pdf_bytes)
        relative_path = f'contracts/acts/{filename}'
        request.act_path = relative_path
        request.act_number = act_number
        request.act_created_at = datetime.utcnow()
        db.commit()
        import urllib.parse
        filename_encoded = urllib.parse.quote(f'Акт_{act_number}.pdf'.encode('utf-8'))
        return Response(content=pdf_bytes, media_type='application/pdf', headers={'Content-Disposition': f"""attachment; filename="act_{request_id}.pdf"; filename*=UTF-8''{filename_encoded}""", 'Content-Type': 'application/pdf'})
    except HTTPException:
        raise
    except Exception as e:
        import traceback
        error_details = traceback.format_exc()
        print(f'Ошибка при генерации акта: {error_details}')
        raise HTTPException(status_code=500, detail=f'Ошибка при генерации акта: {str(e)}')

@app.get('/api/requests/{request_id}/act/sign-nonce')
async def get_act_sign_nonce(request_id: int, db: Session=Depends(get_db), user_id: int=Depends(get_current_user_id)):
    """Получение nonce для подписания акта через ЭЦП"""
    try:
        request = db.query(Request).filter(Request.id == request_id).first()
        if not request:
            raise HTTPException(status_code=404, detail='Заявка не найдена')
        if not request.act_path:
            raise HTTPException(status_code=400, detail='Акт еще не создан. Сначала создайте акт.')
        is_customer = request.customer_id == user_id
        is_carrier = request.selected_carrier_id == user_id
        if not (is_customer or is_carrier):
            raise HTTPException(status_code=403, detail='Только заказчик или перевозчик могут подписать акт')
        import json
        act_signatures_data = {}
        if request.act_signature_cert_data:
            try:
                act_signatures_data = json.loads(request.act_signature_cert_data)
            except:
                pass
        customer_signed = 'customer' in act_signatures_data and act_signatures_data['customer'] is not None
        carrier_signed = 'carrier' in act_signatures_data and act_signatures_data['carrier'] is not None
        if is_customer and customer_signed:
            raise HTTPException(status_code=400, detail='Заказчик уже подписал акт')
        if is_carrier and carrier_signed:
            raise HTTPException(status_code=400, detail='Перевозчик уже подписал акт')
        import secrets
        import uuid
        from datetime import timedelta
        nonce = f'act_{request_id}_{uuid.uuid4().hex}_{secrets.token_hex(16)}'
        expires_at = datetime.utcnow() + timedelta(minutes=10)
        used_nonce = UsedNonce(nonce=nonce, expires_at=expires_at, used_at=None)
        db.add(used_nonce)
        db.commit()
        return {'nonce': nonce, 'expiresAt': expires_at.isoformat()}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f'Ошибка при генерации nonce: {str(e)}')

@app.post('/api/requests/{request_id}/act/verify-signature')
async def verify_act_signature(request_id: int, request_data: VerifyRequest, db: Session=Depends(get_db), user_id: int=Depends(get_current_user_id)):
    """Верификация подписи акта через ЭЦП"""
    try:
        request = db.query(Request).filter(Request.id == request_id).first()
        if not request:
            raise HTTPException(status_code=404, detail='Заявка не найдена')
        if not request.act_path:
            raise HTTPException(status_code=400, detail='Акт еще не создан')
        is_customer = request.customer_id == user_id
        is_carrier = request.selected_carrier_id == user_id
        if not (is_customer or is_carrier):
            raise HTTPException(status_code=403, detail='Только заказчик или перевозчик могут подписать акт')
        from lxml import etree
        root = etree.fromstring(request_data.signedXml.encode('utf-8'))
        extracted_nonce = (root.text or '').strip()
        used_nonce = db.query(UsedNonce).filter(UsedNonce.nonce == extracted_nonce).first()
        if not used_nonce:
            raise HTTPException(status_code=400, detail='Неверный nonce')
        if used_nonce.used_at is not None:
            raise HTTPException(status_code=400, detail='Nonce уже использован')
        if used_nonce.expires_at < datetime.utcnow():
            raise HTTPException(status_code=400, detail='Nonce истек')
        x509_cert_elem = root.find('.//{http://www.w3.org/2000/09/xmldsig#}X509Certificate')
        if x509_cert_elem is None:
            raise HTTPException(status_code=400, detail='Сертификат не найден в подписи')
        cert_pem = x509_cert_elem.text
        cert_bytes = base64.b64decode(cert_pem)
        cert = x509.load_der_x509_certificate(cert_bytes, default_backend())
        subject = cert.subject
        issuer = cert.issuer
        iin = ''
        common_name = ''
        organization = ''
        email = ''
        for attr in subject:
            if attr.oid == x509.NameOID.COMMON_NAME:
                common_name = attr.value
            elif attr.oid == x509.NameOID.ORGANIZATION_NAME:
                organization = attr.value
            elif attr.oid == x509.NameOID.EMAIL_ADDRESS:
                email = attr.value
            oid_str = str(attr.oid)
            if '1.2.643.100.1' in oid_str or '1.2.398.3.3.1.1' in oid_str:
                iin = attr.value
        if not iin:
            for attr in subject:
                if attr.oid == x509.NameOID.SERIAL_NUMBER:
                    value = attr.value
                    if value.isdigit() and len(value) in [10, 12]:
                        iin = value
        cert_data = {'iin': iin, 'full_name': common_name, 'company_name': organization, 'email': email, 'serial_number': format(cert.serial_number, 'X'), 'issuer': issuer.rfc4514_string() if issuer else 'Неизвестный УЦ'}
        is_valid = verify_xml_signature(request_data.signedXml, extracted_nonce, CertificateData(**cert_data))
        if not is_valid:
            raise HTTPException(status_code=400, detail='Неверная подпись')
        import json
        act_signatures_data = {}
        if request.act_signature_cert_data:
            try:
                act_signatures_data = json.loads(request.act_signature_cert_data)
            except:
                pass
        if is_customer:
            act_signatures_data['customer'] = cert_data
            act_signatures_data['customer_signed_at'] = datetime.utcnow().isoformat()
        if is_carrier:
            act_signatures_data['carrier'] = cert_data
            act_signatures_data['carrier_signed_at'] = datetime.utcnow().isoformat()
        request.act_signature_cert_data = json.dumps(act_signatures_data, ensure_ascii=False)
        new_customer_signed = is_customer or ('customer' in act_signatures_data and act_signatures_data['customer'] is not None)
        new_carrier_signed = is_carrier or ('carrier' in act_signatures_data and act_signatures_data['carrier'] is not None)
        both_signed = new_customer_signed and new_carrier_signed
        if both_signed and request.act_path:
            try:
                customer_name = act_signatures_data.get('customer', {}).get('full_name', 'Не указан') if 'customer' in act_signatures_data else 'Не подписан'
                carrier_name = act_signatures_data.get('carrier', {}).get('full_name', 'Не указан') if 'carrier' in act_signatures_data else 'Не подписан'
                signed_pdf_path = await create_signed_pdf_with_qr(contract_id=request_id, original_pdf_path=request.act_path, signer_name=f'{customer_name} (заказчик), {carrier_name} (перевозчик)', signer_iin=cert_data.get('iin', ''), signed_at=datetime.utcnow(), document_kind='act')
                request.signed_act_path = signed_pdf_path
            except Exception as e:
                print(f'Ошибка при создании подписанного PDF акта: {e}')
        used_nonce.used_at = datetime.utcnow()
        db.commit()
        return {'success': True, 'message': 'Акт успешно подписан', 'both_signed': both_signed, 'signed_at': datetime.utcnow().isoformat()}
    except HTTPException:
        raise
    except Exception as e:
        import traceback
        error_details = traceback.format_exc()
        print(f'Ошибка при верификации подписи акта: {error_details}')
        raise HTTPException(status_code=500, detail=f'Ошибка при верификации подписи: {str(e)}')

@app.get('/api/requests/{request_id}/generate-invoice')
async def generate_invoice(request_id: int, db: Session=Depends(get_db), user_id: int=Depends(get_current_user_id)):
    """Генерация счет-фактуры (только после подписания акта обеими сторонами)"""
    try:
        request = db.query(Request).filter(Request.id == request_id).first()
        if not request:
            raise HTTPException(status_code=404, detail='Заявка не найдена')
        if request.selected_carrier_id != user_id:
            raise HTTPException(status_code=403, detail='Только перевозчик может создать счет-фактуру')
        carrier = db.query(User).filter(User.id == user_id).first()
        if not carrier:
            raise HTTPException(status_code=404, detail='Перевозчик не найден')
        missing_fields = []
        if not carrier.recipient_name:
            missing_fields.append('Получатель')
        if not carrier.bank_name:
            missing_fields.append('Банк получателя')
        if not carrier.bank_bik:
            missing_fields.append('БИК')
        if not carrier.bank_account:
            missing_fields.append('Расчётный счёт')
        if missing_fields:
            raise HTTPException(status_code=400, detail={'message': 'Для выставления счёта необходимо заполнить платёжные реквизиты', 'missing_fields': missing_fields, 'error_code': 'PAYMENT_DETAILS_REQUIRED'})
        if not request.signed_act_path:
            raise HTTPException(status_code=400, detail='Счет-фактуру можно создать только после подписания акта обеими сторонами')
        import json
        act_signatures_data = {}
        if request.act_signature_cert_data:
            try:
                act_signatures_data = json.loads(request.act_signature_cert_data)
            except:
                pass
        customer_signed = 'customer' in act_signatures_data and act_signatures_data['customer'] is not None
        carrier_signed = 'carrier' in act_signatures_data and act_signatures_data['carrier'] is not None
        if not (customer_signed and carrier_signed):
            raise HTTPException(status_code=400, detail='Счет-фактуру можно создать только после подписания акта обеими сторонами')
        if request.invoice_path:
            raise HTTPException(status_code=400, detail='Счет-фактура уже создана')
        from sqlalchemy.orm import joinedload
        request = db.query(Request).options(joinedload(Request.customer), joinedload(Request.selected_carrier), joinedload(Request.assigned_driver), joinedload(Request.assigned_vehicle), joinedload(Request.selected_bid)).filter(Request.id == request_id).first()
        customer = request.customer
        carrier = request.selected_carrier
        driver = request.assigned_driver
        vehicle = request.assigned_vehicle
        selected_bid = request.selected_bid
        if not customer or not carrier:
            raise HTTPException(status_code=404, detail='Не удалось загрузить данные заказчика или перевозчика')
        invoice_number = f"СФ-{request.id}-{datetime.utcnow().strftime('%Y%m%d')}"
        invoice_date = datetime.utcnow().strftime('%d.%m.%Y')
        request_date = request.created_at.strftime('%d.%m.%Y') if request.created_at else invoice_date
        loading_date = request.loading_date.strftime('%d.%m.%Y') if request.loading_date else ''
        loading_time = request.loading_date.strftime('%H:%M') if request.loading_date else ''
        delivery_date = request.delivery_date.strftime('%d.%m.%Y') if request.delivery_date else ''
        delivery_time = request.delivery_date.strftime('%H:%M') if request.delivery_date else ''
        price = selected_bid.price if selected_bid else request.max_price or 0
        customer_contacts = []
        if customer.full_name and customer.phone:
            customer_contacts.append({'name': customer.full_name, 'phone': customer.phone, 'email': customer.email or ''})
        jinja_env = get_jinja_env()
        template = jinja_env.get_template('invoice.html')

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
        total_amount = price
        currency = carrier.payment_currency or 'KZT'
        total_amount_words = number_to_words(total_amount, currency)
        currency_symbol = '₸' if currency == 'KZT' else '₽' if currency == 'RUB' else currency
        supplier_company = carrier.recipient_name or carrier.company_name or carrier.full_name
        html_content = template.render(invoice_number=invoice_number, invoice_date=invoice_date, bank_name=carrier.bank_name or 'Банк получателя', bank_bik=carrier.bank_bik or '-', bank_corr_account=carrier.bank_corr_account or '-', supplier_inn=carrier.iin or '-', supplier_kpp=carrier.kpp or '-', supplier_account=carrier.bank_account or '-', supplier_company=supplier_company, supplier_address=carrier.address or '-', customer_company=customer.company_name or customer.full_name, customer_inn=customer.iin or '-', customer_kpp=getattr(customer, 'kpp', None) or '-', customer_address=getattr(customer, 'address', None) or '-', from_city=request.from_city, to_city=request.to_city, price=f'{price:,.0f}'.replace(',', ' ') + f' {currency_symbol}', vat_amount=None, total_amount=f'{total_amount:,.0f}'.replace(',', ' ') + f' {currency_symbol}', total_amount_words=total_amount_words, director_name=carrier.director_name or '', accountant_name=carrier.accountant_name or '', currency=currency_symbol)
        from weasyprint import HTML
        from io import BytesIO
        import os
        if os.path.exists('/opt/homebrew/lib'):
            os.environ['DYLD_LIBRARY_PATH'] = '/opt/homebrew/lib'
        elif os.path.exists('/usr/local/lib'):
            os.environ['DYLD_LIBRARY_PATH'] = '/usr/local/lib'
        pdf_buffer = BytesIO()
        html_doc = HTML(string=html_content, base_url=str(Path.cwd()))
        html_doc.write_pdf(pdf_buffer)
        pdf_bytes = pdf_buffer.getvalue()
        pdf_buffer.close()
        backend_dir = Path(__file__).parent
        invoices_dir = backend_dir / 'contracts' / 'invoices'
        invoices_dir.mkdir(parents=True, exist_ok=True)
        filename = f"invoice_{request_id}_{datetime.utcnow().strftime('%Y%m%d_%H%M%S')}.pdf"
        file_path = invoices_dir / filename
        with open(file_path, 'wb') as f:
            f.write(pdf_bytes)
        relative_path = f'contracts/invoices/{filename}'
        request.invoice_path = relative_path
        request.invoice_number = invoice_number
        request.invoice_created_at = datetime.utcnow()
        db.commit()
        import urllib.parse
        filename_encoded = urllib.parse.quote(f'Счет-фактура_{invoice_number}.pdf'.encode('utf-8'))
        return Response(content=pdf_bytes, media_type='application/pdf', headers={'Content-Disposition': f"""attachment; filename="invoice_{request_id}.pdf"; filename*=UTF-8''{filename_encoded}""", 'Content-Type': 'application/pdf'})
    except HTTPException:
        raise
    except Exception as e:
        import traceback
        error_details = traceback.format_exc()
        print(f'Ошибка при генерации счет-фактуры: {error_details}')
        raise HTTPException(status_code=500, detail=f'Ошибка при генерации счет-фактуры: {str(e)}')

class ChatResponse(BaseModel):
    response: str

@app.post('/api/chat', response_model=ChatResponse)
async def chat_with_ai(chat_data: ChatMessage, user_id: int=Depends(get_current_user_id), db: Session=Depends(get_db)):
    """AI чат-бот для помощи пользователям"""
    try:
        user = db.query(User).filter(User.id == user_id).first()
        user_context = None
        if user:
            user_context = {'user_id': user.id, 'user_name': user.full_name or user.company_name, 'user_type': 'carrier' if user.company_name else 'customer'}
        ai_response = get_ai_chat_response(chat_data.message, user_context)
        return ChatResponse(response=ai_response)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f'Ошибка при обработке запроса: {str(e)}')

@app.get('/api/egov/company/{bin}')
async def get_company_by_bin_api(bin: str, db: Session=Depends(get_db), user_id: int=Depends(get_current_user_id)):
    """
    Получение данных о компании по БИН или ИИН из data.egov.kz
    
    Примечание: API data.egov.kz поддерживает проверку только по БИН (для юридических лиц и ИП).
    Проверка по ИИН (для физических лиц) может быть недоступна.
    
    Args:
        bin: БИН компании (12 цифр) или ИИН (12 цифр)
    
    Returns:
        Данные о компании или ошибка
    """
    try:
        from egov_api import get_company_by_bin
        if not bin or len(bin) != 12 or (not bin.isdigit()):
            raise HTTPException(status_code=400, detail='БИН/ИИН должен содержать 12 цифр')
        company_data = get_company_by_bin(bin, db)
        if not company_data:
            raise HTTPException(status_code=404, detail='Компания с указанным БИН/ИИН не найдена в реестре data.egov.kz. Примечание: API поддерживает проверку только по БИН (для юридических лиц и ИП). Проверка по ИИН (для физических лиц) может быть недоступна.')
        return {'success': True, 'data': company_data, 'source': 'data.egov.kz', 'message': 'Данные получены с портала открытых данных'}
    except HTTPException:
        raise
    except Exception as e:
        import traceback
        error_details = traceback.format_exc()
        print(f'Ошибка при получении данных из data.egov.kz: {error_details}')
        raise HTTPException(status_code=500, detail=f'Ошибка при получении данных: {str(e)}')

@app.post('/api/egov/verify-company')
async def verify_company_api(request_data: dict, db: Session=Depends(get_db), user_id: int=Depends(get_current_user_id)):
    """
    Верификация данных компании через data.egov.kz
    
    Body:
        {
            "bin": "123456789012",
            "company_name": "Название компании"
        }
    """
    try:
        from egov_api import verify_company_data
        bin = request_data.get('bin')
        company_name = request_data.get('company_name', '')
        if not bin:
            raise HTTPException(status_code=400, detail='БИН обязателен')
        verification_result = verify_company_data(bin, company_name, db)
        return {'success': True, 'verification': verification_result, 'source': 'data.egov.kz'}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f'Ошибка при верификации: {str(e)}')

@app.get('/api/organizations', response_model=List[OrganizationResponse])
async def get_organizations(source: Optional[str]=None, db: Session=Depends(get_db), user_id: int=Depends(get_current_user_id)):
    """
    Получение списка организаций.
    
    Если source="egov" - возвращает компании из data.egov.kz, связанные с логистикой.
    Если source="database" или не указан - возвращает зарегистрированных пользователей.
    """
    try:
        if source == 'egov':
            from egov_api import search_companies_by_activity
            keywords = ['груз', 'перевоз', 'транспорт', 'логистик', 'доставк', 'экспедитор']
            companies = search_companies_by_activity(keywords, db, limit=50)
            partnerships = db.query(Partnership).filter((Partnership.company1_id == user_id) | (Partnership.company2_id == user_id)).all()
            partnership_map_by_bin = {}
            for p in partnerships:
                partner_id = p.company2_id if p.company1_id == user_id else p.company1_id
                partner = db.query(User).filter(User.id == partner_id).first()
                i_am_company1 = p.company1_id == user_id
                my_sig_done = bool(p.signature1_xml if i_am_company1 else p.signature2_xml)
                if partner and partner.bin:
                    partnership_map_by_bin[partner.bin] = {'status': p.status, 'id': p.id, 'my_signature_done': my_sig_done, 'signed_at': p.signed_at}
            result = []
            for company in companies:
                bin_value = company.get('bin', '')
                if not bin_value:
                    continue
                partnership_info = partnership_map_by_bin.get(bin_value)
                has_partnership = partnership_info is not None
                registered_user = db.query(User).filter(User.bin == bin_value).first()
                result.append(OrganizationResponse(id=registered_user.id if registered_user else None, company_name=company.get('nameru') or company.get('namekk') or company.get('namekz') or '', full_name=company.get('director', ''), bin=bin_value, email=None, phone=None, address=company.get('addressru') or company.get('addresskk') or company.get('addresskz') or '', has_partnership=has_partnership, partnership_status=partnership_info['status'] if partnership_info else None, partnership_id=partnership_info['id'] if partnership_info else None, partnership_my_signature_done=partnership_info.get('my_signature_done') if partnership_info else None, partnership_signed_at=partnership_info.get('signed_at') if partnership_info else None))
            return result
        else:
            users = db.query(User).filter(User.is_active == True).all()
            partnerships = db.query(Partnership).filter((Partnership.company1_id == user_id) | (Partnership.company2_id == user_id)).all()
            partnership_map = {}
            for p in partnerships:
                other_company_id = p.company2_id if p.company1_id == user_id else p.company1_id
                i_am_company1 = p.company1_id == user_id
                my_sig_done = bool(p.signature1_xml if i_am_company1 else p.signature2_xml)
                partnership_map[other_company_id] = {'status': p.status, 'id': p.id, 'my_signature_done': my_sig_done, 'signed_at': p.signed_at}
            result = []
            for user in users:
                if user.id == user_id:
                    continue
                has_partnership = user.id in partnership_map
                partnership_info = partnership_map.get(user.id)
                result.append(OrganizationResponse(id=user.id, company_name=user.company_name, full_name=user.full_name, bin=user.bin, email=user.email, phone=user.phone, address=user.address, has_partnership=has_partnership, partnership_status=partnership_info['status'] if partnership_info else None, partnership_id=partnership_info['id'] if partnership_info else None, partnership_my_signature_done=partnership_info.get('my_signature_done') if partnership_info else None, partnership_signed_at=partnership_info.get('signed_at') if partnership_info else None, is_registered=True))
            return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=f'Ошибка при получении списка организаций: {str(e)}')

@app.post('/api/partnerships', response_model=PartnershipResponse)
async def create_partnership(partnership_data: PartnershipCreate, db: Session=Depends(get_db), user_id: int=Depends(get_current_user_id)):
    """Создание запроса на партнерство"""
    try:
        company2 = db.query(User).filter(User.id == partnership_data.company2_id).first()
        if not company2:
            raise HTTPException(status_code=404, detail='Компания не найдена')
        if company2.id == user_id:
            raise HTTPException(status_code=400, detail='Нельзя создать партнерство с самим собой')
        existing = db.query(Partnership).filter((Partnership.company1_id == user_id) & (Partnership.company2_id == partnership_data.company2_id) | (Partnership.company1_id == partnership_data.company2_id) & (Partnership.company2_id == user_id)).first()
        if existing:
            raise HTTPException(status_code=400, detail='Партнерство уже существует или запрос уже отправлен')
        new_partnership = Partnership(company1_id=user_id, company2_id=partnership_data.company2_id, status=PartnershipStatus.PENDING.value)
        db.add(new_partnership)
        db.commit()
        db.refresh(new_partnership)
        company1 = db.query(User).filter(User.id == user_id).first()
        return PartnershipResponse(id=new_partnership.id, company1_id=new_partnership.company1_id, company2_id=new_partnership.company2_id, company1_name=company1.company_name or company1.full_name, company2_name=company2.company_name or company2.full_name, status=new_partnership.status, created_at=new_partnership.created_at)
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f'Ошибка при создании партнерства: {str(e)}')

@app.get('/api/partnerships', response_model=List[PartnershipResponse])
async def get_partnerships(db: Session=Depends(get_db), user_id: int=Depends(get_current_user_id)):
    """Получение списка партнерств текущего пользователя"""
    try:
        partnerships = db.query(Partnership).filter((Partnership.company1_id == user_id) | (Partnership.company2_id == user_id)).order_by(Partnership.created_at.desc()).all()
        result = []
        for p in partnerships:
            company1 = db.query(User).filter(User.id == p.company1_id).first()
            company2 = db.query(User).filter(User.id == p.company2_id).first()
            result.append(PartnershipResponse(id=p.id, company1_id=p.company1_id, company2_id=p.company2_id, company1_name=company1.company_name or company1.full_name if company1 else None, company2_name=company2.company_name or company2.full_name if company2 else None, status=p.status, document_path=p.document_path, signed_document_path=p.signed_document_path, created_at=p.created_at, signed_at=p.signed_at, rejected_at=p.rejected_at, rejection_reason=p.rejection_reason, expires_at=p.expires_at))
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=f'Ошибка при получении партнерств: {str(e)}')

@app.get('/api/partnerships/check/{company_id}')
async def check_partnership(company_id: int, db: Session=Depends(get_db), user_id: int=Depends(get_current_user_id)):
    """Проверка наличия активного партнерства с компанией"""
    try:
        partnership = db.query(Partnership).filter((Partnership.company1_id == user_id) & (Partnership.company2_id == company_id) | (Partnership.company1_id == company_id) & (Partnership.company2_id == user_id), Partnership.status == PartnershipStatus.SIGNED.value).first()
        return {'has_partnership': partnership is not None, 'partnership_id': partnership.id if partnership else None}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f'Ошибка при проверке партнерства: {str(e)}')

@app.get('/api/partnerships/{partnership_id}/agreement', response_class=HTMLResponse)
async def get_partnership_agreement_html(partnership_id: int, db: Session=Depends(get_db), user_id: int=Depends(get_current_user_id)):
    """Текст договора для ознакомления перед подписанием (HTML): шаблон договора перевозки (contract_carriage.html)."""
    partnership = db.query(Partnership).filter(Partnership.id == partnership_id).first()
    if not partnership:
        raise HTTPException(status_code=404, detail='Партнёрство не найдено')
    if partnership.company1_id != user_id and partnership.company2_id != user_id:
        raise HTTPException(status_code=403, detail='Вы не участник этого партнёрства')
    u1 = db.query(User).filter(User.id == partnership.company1_id).first()
    u2 = db.query(User).filter(User.id == partnership.company2_id).first()
    if not u1 or not u2:
        raise HTTPException(status_code=404, detail='Участник партнёрства не найден')

    def _p_format_date_ru(dt):
        if not dt:
            return None
        return dt.strftime('%d.%m.%Y')

    def _p_format_date_ru_long(dt):
        if not dt:
            return ''
        months = ('', 'января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря')
        return f'«{dt.day}» {months[dt.month]} {dt.year} г.'
    now_utc = datetime.utcnow()
    pn = str(partnership.id)
    req_date = _p_format_date_ru(partnership.created_at) if partnership.created_at else _p_format_date_ru(now_utc)
    template_data = {'platform_name': 'AituCargo', 'contract_number': pn, 'contract_city': '', 'contract_date': _p_format_date_ru(now_utc), 'contract_date_long': _p_format_date_ru_long(now_utc), 'request_number': pn, 'request_date': req_date, 'customer_company': u1.company_name or u1.full_name or '—', 'customer_contact': u1.full_name or '', 'customer_phone': u1.phone or '', 'customer_accounting_phone': '', 'customer_accounting_email': '', 'customer_inn': u1.iin or '', 'customer_bin': (u1.bin or '').strip() or (u1.iin or '').strip(), 'customer_address': (u1.address or '').strip() or '____________________________', 'customer_kpp': '', 'carrier_company': u2.company_name or u2.full_name or '—', 'carrier_contact': u2.full_name or '', 'carrier_phone': u2.phone or '', 'carrier_accounting_phone': '', 'carrier_accounting_email': '', 'carrier_inn': u2.iin or '', 'carrier_bin': (u2.bin or '').strip(), 'carrier_address': (u2.address or '').strip() or '____________________________', 'carrier_kpp': '', 'loading_date': '—', 'loading_time': '', 'loading_address': '—', 'loading_contact': '', 'loading_phone': '', 'loading_info': '', 'delivery_date': '—', 'delivery_time': '', 'delivery_address': '—', 'delivery_contact': '', 'delivery_phone': '', 'delivery_info': '', 'cargo_name': '—', 'cargo_weight': '', 'cargo_volume': '', 'body_type': '—', 'loading_type': '', 'cargo_requirements': '', 'price': '—', 'payment_terms': '', 'driver_name': '—', 'driver_phone': '', 'driver_passport': '', 'driver_passport_issued': '', 'driver_birth_date': '', 'vehicle_info': '—'}
    _bd = Path(__file__).parent
    template_path = Path('templates') / 'contract_carriage.html'
    if not template_path.exists():
        template_path = _bd / 'templates' / 'contract_carriage.html'
    if not template_path.exists():
        raise HTTPException(status_code=500, detail='Шаблон договора перевозки (contract_carriage.html) не найден')
    template = Template(template_path.read_text(encoding='utf-8'))
    html = template.render(**template_data)
    return HTMLResponse(content=html)
_PARTNERSHIP_NONCE_IN_XML_RE = re.compile('partnership_\\d+_[0-9a-fA-F]{32}_[0-9a-fA-F]{32}')

def _extract_nonce_from_partnership_signed_xml(signed_xml: str) -> str:
    """Nonce в <partnership>…</partnership>; после ЭЦП текст может уйти из root.text — ищем по шаблону."""
    try:
        root = etree.fromstring(signed_xml.encode('utf-8'))
    except etree.XMLSyntaxError:
        return ''
    t = (root.text or '').strip()
    if t:
        return t
    blob = ''.join(root.itertext())
    m = _PARTNERSHIP_NONCE_IN_XML_RE.search(blob)
    return m.group(0) if m else ''

def _partnership_to_api_response(db: Session, partnership: Partnership) -> PartnershipResponse:
    company1 = db.query(User).filter(User.id == partnership.company1_id).first()
    company2 = db.query(User).filter(User.id == partnership.company2_id).first()
    return PartnershipResponse(id=partnership.id, company1_id=partnership.company1_id, company2_id=partnership.company2_id, company1_name=company1.company_name or company1.full_name if company1 else None, company2_name=company2.company_name or company2.full_name if company2 else None, status=partnership.status, document_path=partnership.document_path, signed_document_path=partnership.signed_document_path, created_at=partnership.created_at, signed_at=partnership.signed_at)

@app.get('/api/partnerships/{partnership_id}/sign-nonce')
async def get_partnership_sign_nonce(partnership_id: int, db: Session=Depends(get_db), user_id: int=Depends(get_current_user_id)):
    """Получение nonce для подписания договора партнерства"""
    try:
        partnership = db.query(Partnership).filter(Partnership.id == partnership_id).first()
        if not partnership:
            raise HTTPException(status_code=404, detail='Партнерство не найдено')
        if partnership.company1_id != user_id and partnership.company2_id != user_id:
            raise HTTPException(status_code=403, detail='Вы не являетесь участником этого партнерства')
        if partnership.status == PartnershipStatus.SIGNED.value:
            raise HTTPException(status_code=400, detail='Партнерство уже подписано')
        if partnership.status == PartnershipStatus.REJECTED.value:
            raise HTTPException(status_code=400, detail='Партнерство отклонено')
        import uuid
        nonce = f'partnership_{partnership_id}_{uuid.uuid4().hex}_{secrets.token_hex(16)}'
        expires_at = datetime.utcnow() + timedelta(minutes=10)
        used_nonce = UsedNonce(nonce=nonce, expires_at=expires_at)
        db.add(used_nonce)
        db.commit()
        return NonceResponse(nonce=nonce, expires_at=expires_at)
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f'Ошибка при генерации nonce: {str(e)}')

@app.post('/api/partnerships/{partnership_id}/verify-signature')
async def verify_partnership_signature(partnership_id: int, request_data: PartnershipSign, db: Session=Depends(get_db), user_id: int=Depends(get_current_user_id)):
    """Верификация подписи договора партнерства"""
    try:
        partnership = db.query(Partnership).filter(Partnership.id == partnership_id).first()
        if not partnership:
            raise HTTPException(status_code=404, detail='Партнерство не найдено')
        is_company1 = partnership.company1_id == user_id
        is_company2 = partnership.company2_id == user_id
        if not (is_company1 or is_company2):
            raise HTTPException(status_code=403, detail='Вы не являетесь участником этого партнерства')
        extracted_nonce = _extract_nonce_from_partnership_signed_xml(request_data.signed_xml)
        if not extracted_nonce:
            raise HTTPException(status_code=400, detail='Не удалось извлечь nonce из подписанного XML')
        root = etree.fromstring(request_data.signed_xml.encode('utf-8'))
        used_nonce = db.query(UsedNonce).filter(UsedNonce.nonce == extracted_nonce).first()
        if not used_nonce:
            raise HTTPException(status_code=400, detail='Неверный nonce')
        if used_nonce.used_at is not None:
            if is_company1 and partnership.signature1_xml:
                return _partnership_to_api_response(db, partnership)
            if is_company2 and partnership.signature2_xml:
                return _partnership_to_api_response(db, partnership)
            raise HTTPException(status_code=400, detail='Nonce уже использован')
        if used_nonce.expires_at < datetime.utcnow():
            raise HTTPException(status_code=400, detail='Nonce истек')
        try:
            cert_model = certificate_data_from_xml_signature_root(root)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))
        except Exception as e:
            raise HTTPException(status_code=400, detail=f'Ошибка разбора сертификата из подписи: {str(e)}')
        is_valid = verify_xml_signature(request_data.signed_xml, extracted_nonce, cert_model)
        if not is_valid:
            raise HTTPException(status_code=400, detail='Неверная подпись')
        signer = db.query(User).filter(User.id == user_id).first()
        if signer and signer.iin and cert_model.iin:
            signer_iin_clean = ''.join(filter(str.isdigit, str(signer.iin).strip()))
            cert_iin_clean = ''.join(filter(str.isdigit, str(cert_model.iin).strip()))
            if signer_iin_clean and cert_iin_clean and (signer_iin_clean != cert_iin_clean):
                raise HTTPException(status_code=403, detail='Подпись должна быть выполнена вашим сертификатом. ИИН в сертификате не совпадает с вашим ИИН в системе.')
        cert_json = {'iin': cert_model.iin, 'full_name': cert_model.full_name, 'company_name': cert_model.company_name, 'email': cert_model.email, 'serial_number': cert_model.serial_number, 'issuer': cert_model.issuer, 'valid_from': cert_model.valid_from.isoformat() if cert_model.valid_from else None, 'valid_to': cert_model.valid_to.isoformat() if cert_model.valid_to else None}
        if is_company1:
            partnership.signature1_xml = request_data.signed_xml
            partnership.signature1_cert_data = json.dumps(cert_json, ensure_ascii=False)
        else:
            partnership.signature2_xml = request_data.signed_xml
            partnership.signature2_cert_data = json.dumps(cert_json, ensure_ascii=False)
        if partnership.signature1_xml and partnership.signature2_xml:
            partnership.status = PartnershipStatus.SIGNED.value
            partnership.signed_at = datetime.utcnow()
        used_nonce.used_at = datetime.utcnow()
        db.commit()
        return _partnership_to_api_response(db, partnership)
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f'Ошибка при верификации подписи: {str(e)}')
if __name__ == '__main__':
    import uvicorn
    uvicorn.run(app, host='0.0.0.0', port=8000)
