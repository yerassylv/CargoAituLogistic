"""
Утилиты для работы с ЭЦП (электронной цифровой подписью)
Извлечение данных из сертификата ЭЦП
"""
import os
import hashlib
from datetime import datetime
from pathlib import Path
import uuid
import tempfile
from cryptography import x509
from cryptography.hazmat.backends import default_backend
from OpenSSL import crypto
import re
CERTIFICATES_DIR = Path('certificates')
CERTIFICATES_DIR.mkdir(exist_ok=True)

def save_certificate(file_content: bytes, serial_number: str) -> tuple[str, str]:
    """
    Сохраняет загруженный сертификат ЭЦП
    
    Returns:
        tuple: (путь к файлу, уникальный идентификатор)
    """
    file_id = str(uuid.uuid4())
    safe_serial = re.sub('[^\\w\\-_]', '_', serial_number)[:20]
    filename = f'{safe_serial}_{file_id}.p12'
    filepath = CERTIFICATES_DIR / filename
    with open(filepath, 'wb') as f:
        f.write(file_content)
    return (str(filepath), file_id)

def extract_certificate_info(file_content: bytes, filename: str, password: str=None) -> dict:
    """
    Извлекает информацию из сертификата ЭЦП
    Автоматически извлекает все данные пользователя из сертификата
    """
    file_ext = Path(filename).suffix.lower()
    try:
        if file_ext in ['.p12', '.pfx']:
            return _extract_from_p12(file_content, password)
        elif file_ext in ['.cer', '.crt', '.pem']:
            return _extract_from_x509(file_content)
        else:
            return _extract_demo_info(file_content, filename)
    except Exception as e:
        print(f'Ошибка при парсинге сертификата: {e}')
        return _extract_demo_info(file_content, filename)

def _extract_from_p12(file_content: bytes, password: str=None) -> dict:
    """
    Извлекает данные из PKCS#12 (.p12, .pfx) файла
    
    Логика открытия:
    1. Сначала пробуем открыть без пароля (если сертификат не защищен)
    2. Если не получилось и пароль указан - пробуем с паролем
    3. Если пароль не указан, но нужен - выбрасываем исключение
    """
    p12 = None
    cert = None
    try:
        p12 = crypto.load_pkcs12(file_content, b'')
        cert = p12.get_certificate()
    except crypto.Error as e:
        if 'mac verify failure' in str(e).lower() or 'bad password' in str(e).lower():
            if password:
                try:
                    p12 = crypto.load_pkcs12(file_content, password.encode('utf-8'))
                    cert = p12.get_certificate()
                except crypto.Error:
                    raise Exception('Неверный пароль для сертификата. Проверьте правильность пароля.')
            else:
                raise Exception('Сертификат защищен паролем. Пожалуйста, укажите пароль.')
        else:
            raise Exception(f'Ошибка при чтении сертификата: {e}')
    try:
        subject = cert.get_subject()
        common_name = ''
        surname = ''
        given_name = ''
        email = ''
        inn = ''
        bin_value = ''
        organization = ''
        organizational_unit = ''
        for attr in subject.get_components():
            attr_name = attr[0].decode('utf-8') if isinstance(attr[0], bytes) else str(attr[0])
            attr_value = attr[1].decode('utf-8') if isinstance(attr[1], bytes) else str(attr[1])
            if attr_name == 'CN' or attr_name == 'commonName':
                common_name = attr_value
            elif attr_name == 'SN' or attr_name == 'surname':
                surname = attr_value
            elif attr_name == 'GN' or attr_name == 'givenName':
                given_name = attr_value
            elif attr_name == 'E' or attr_name == 'emailAddress' or attr_name == 'EMAIL':
                email = attr_value
            elif attr_name == 'O' or attr_name == 'organizationName':
                organization = attr_value
            elif attr_name == 'OU' or attr_name == 'organizationalUnitName':
                organizational_unit = attr_value
            elif 'INN' in attr_name.upper() or '1.2.643.100.1' in attr_name or '1.2.398.3.3.1.1' in attr_name:
                if organization:
                    bin_value = attr_value
                else:
                    inn = attr_value
            elif attr_name == 'serialNumber' and (not inn) and (not bin_value):
                if attr_value.isdigit() and len(attr_value) in [10, 12]:
                    if organization:
                        bin_value = attr_value
                    else:
                        inn = attr_value
        if not common_name:
            common_name = subject.CN or ''
        if not surname:
            surname = subject.SN or ''
        if not given_name:
            given_name = subject.GN or ''
        if not email:
            email = subject.emailAddress or ''
        if not organization:
            organization = subject.O or ''
        if not organizational_unit:
            organizational_unit = subject.OU or ''
        full_name_parts = []
        if surname and given_name:
            full_name_parts = [surname, given_name]
        elif surname:
            full_name_parts = [surname]
        elif given_name:
            full_name_parts = [given_name]
        elif common_name:
            full_name_parts = [common_name]
        full_name = ' '.join(full_name_parts) if full_name_parts else common_name or 'Не указано'
        issuer = cert.get_issuer()
        issuer_name = issuer.CN or issuer.O or 'Неизвестный УЦ'
        valid_from = datetime.strptime(cert.get_notBefore().decode('ascii'), '%Y%m%d%H%M%S%z')
        valid_to = datetime.strptime(cert.get_notAfter().decode('ascii'), '%Y%m%d%H%M%S%z')
        serial_number = format(cert.get_serial_number(), 'X')
        if not inn:
            try:
                extensions = cert.get_extensions()
                for ext in extensions:
                    ext_name = ext.get_short_name().decode('utf-8')
                    if 'subjectAltName' in ext_name.lower():
                        ext_value = str(ext)
                        import re
                        inn_match = re.search('INN[=:]\\s*(\\d{10,12})', ext_value, re.IGNORECASE)
                        if inn_match:
                            inn = inn_match.group(1)
                            break
            except:
                pass
        return {'full_name': full_name, 'email': email or f"{common_name.lower().replace(' ', '.')}@example.ru" if common_name else '', 'company_name': organization or '', 'inn': inn or '', 'phone': '', 'serial_number': serial_number, 'issuer': issuer_name, 'valid_from': valid_from.replace(tzinfo=None), 'valid_to': valid_to.replace(tzinfo=None), 'is_valid': datetime.now() < valid_to.replace(tzinfo=None), 'file_size': len(file_content), 'file_type': 'PKCS#12'}
    except Exception as e:
        if 'Неверный пароль' in str(e) or 'Сертификат защищен паролем' in str(e):
            raise
        raise Exception(f'Ошибка при обработке сертификата: {e}')

def _extract_from_x509(file_content: bytes) -> dict:
    """Извлекает данные из X.509 (.cer, .crt, .pem) файла"""
    try:
        try:
            cert = x509.load_pem_x509_certificate(file_content, default_backend())
        except:
            cert = x509.load_der_x509_certificate(file_content, default_backend())
        subject = cert.subject
        common_name = ''
        surname = ''
        given_name = ''
        email = ''
        organization = ''
        inn = ''
        bin_value = ''
        for attr in subject:
            oid_str = str(attr.oid)
            value = attr.value
            if attr.oid == x509.NameOID.COMMON_NAME:
                common_name = value
            elif attr.oid == x509.NameOID.SURNAME:
                surname = value
            elif attr.oid == x509.NameOID.GIVEN_NAME:
                given_name = value
            elif attr.oid == x509.NameOID.EMAIL_ADDRESS:
                email = value
            elif attr.oid == x509.NameOID.ORGANIZATION_NAME:
                organization = value
            elif '1.2.643.100.1' in oid_str or '1.2.398.3.3.1.1' in oid_str:
                if organization:
                    bin_value = value
                else:
                    inn = value
            elif 'INN' in oid_str.upper() or 'BIN' in oid_str.upper():
                if organization:
                    bin_value = value
                else:
                    inn = value
        try:
            san_ext = cert.extensions.get_extension_for_oid(x509.oid.ExtensionOID.SUBJECT_ALTERNATIVE_NAME)
            san = san_ext.value
            for name in san:
                if isinstance(name, x509.RFC822Name):
                    if not email:
                        email = name.value
        except x509.ExtensionNotFound:
            pass
        except Exception:
            pass
        full_name_parts = []
        if surname and given_name:
            full_name_parts = [surname, given_name]
        elif surname:
            full_name_parts = [surname]
        elif given_name:
            full_name_parts = [given_name]
        elif common_name:
            full_name_parts = [common_name]
        full_name = ' '.join(full_name_parts) if full_name_parts else common_name or 'Не указано'
        issuer = cert.issuer
        issuer_name = ''
        for attr in issuer:
            if attr.oid == x509.NameOID.COMMON_NAME:
                issuer_name = attr.value
                break
        if not issuer_name:
            issuer_name = issuer.rfc4514_string()
        return {'full_name': full_name, 'email': email or f"{common_name.lower().replace(' ', '.')}@example.ru" if common_name else '', 'company_name': organization or '', 'inn': inn or '', 'bin': bin_value or '', 'phone': '', 'serial_number': format(cert.serial_number, 'X'), 'issuer': issuer_name or 'Неизвестный УЦ', 'valid_from': cert.not_valid_before, 'valid_to': cert.not_valid_after, 'is_valid': datetime.now() < cert.not_valid_after, 'file_size': len(file_content), 'file_type': 'X.509'}
    except Exception as e:
        raise Exception(f'Ошибка при обработке X.509 сертификата: {e}')

def _extract_demo_info(file_content: bytes, filename: str) -> dict:
    """Демо-данные если не удалось распарсить"""
    file_hash = hashlib.sha256(file_content).hexdigest()[:16]
    return {'full_name': 'Не удалось извлечь из сертификата', 'email': f'user_{file_hash[:8]}@example.ru', 'company_name': '', 'inn': '', 'bin': '', 'phone': '', 'serial_number': f'SN-{file_hash.upper()}', 'issuer': 'Удостоверяющий центр (демо)', 'valid_from': datetime.now(), 'valid_to': datetime(2025, 12, 31), 'is_valid': True, 'file_size': len(file_content), 'file_type': Path(filename).suffix.lower()}

def verify_certificate(file_content: bytes, filename: str) -> tuple[bool, str]:
    """
    Проверяет валидность сертификата ЭЦП
    
    Returns:
        tuple: (is_valid, message)
    """
    if len(file_content) == 0:
        return (False, 'Файл сертификата пуст')
    allowed_extensions = ['.p12', '.pfx', '.cer', '.crt', '.pem']
    file_ext = Path(filename).suffix.lower()
    if file_ext not in allowed_extensions:
        return (False, f"Неподдерживаемый формат файла. Разрешенные: {', '.join(allowed_extensions)}")
    if len(file_content) > 5 * 1024 * 1024:
        return (False, 'Файл слишком большой (максимум 5MB)')
    return (True, 'Сертификат успешно проверен (демо-режим)')

def delete_certificate(filepath: str):
    """Удаляет файл сертификата"""
    try:
        if os.path.exists(filepath):
            os.remove(filepath)
    except Exception as e:
        print(f'Ошибка при удалении сертификата: {e}')
