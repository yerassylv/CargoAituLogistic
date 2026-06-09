from sqlalchemy import create_engine, Column, Integer, String, DateTime, Text, Boolean, Float, ForeignKey, Enum as SQLEnum
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker, relationship
from datetime import datetime
import os
import enum
from dotenv import load_dotenv
load_dotenv()
DATABASE_URL = os.getenv('DATABASE_URL')
if DATABASE_URL and DATABASE_URL.startswith('postgresql'):
    _pool_size = int(os.getenv('DB_POOL_SIZE', '5'))
    _max_overflow = int(os.getenv('DB_MAX_OVERFLOW', '10'))
    _pool_timeout = int(os.getenv('DB_POOL_TIMEOUT', '30'))
    _connect_args = {'sslmode': os.getenv('PG_SSLMODE', 'require')}
    engine = create_engine(DATABASE_URL, pool_pre_ping=True, pool_recycle=int(os.getenv('DB_POOL_RECYCLE', '280')), pool_size=_pool_size, max_overflow=_max_overflow, pool_timeout=_pool_timeout, connect_args=_connect_args)
    print('✅ Используется PostgreSQL (облачная БД)')
else:
    db_path = os.path.join(os.path.dirname(__file__), 'cargoainur.db')
    engine = create_engine(f'sqlite:///{db_path}', connect_args={'check_same_thread': False})
    print('✅ Используется SQLite (локальная БД)')
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine, expire_on_commit=False)
Base = declarative_base()

class User(Base):
    __tablename__ = 'users'
    id = Column(Integer, primary_key=True, index=True)
    iin = Column(String, unique=True, index=True, nullable=False)
    bin = Column(String, nullable=True, index=True)
    full_name = Column(String, nullable=False)
    email = Column(String, index=True)
    company_name = Column(String)
    phone = Column(String)
    kpp = Column(String, nullable=True)
    address = Column(String, nullable=True)
    bank_name = Column(String, nullable=True)
    bank_bik = Column(String, nullable=True)
    bank_corr_account = Column(String, nullable=True)
    bank_account = Column(String, nullable=True)
    director_name = Column(String, nullable=True)
    accountant_name = Column(String, nullable=True)
    recipient_name = Column(String, nullable=True)
    payment_currency = Column(String, nullable=True, default='KZT')
    cert_serial = Column(String, index=True)
    cert_issuer = Column(String)
    cert_valid_from = Column(DateTime)
    cert_valid_to = Column(DateTime)
    created_at = Column(DateTime, default=datetime.utcnow)
    last_login = Column(DateTime)
    is_active = Column(Boolean, default=True)

class UsedNonce(Base):
    """Хранение использованных nonce для защиты от replay-атак"""
    __tablename__ = 'used_nonces'
    id = Column(Integer, primary_key=True, index=True)
    nonce = Column(String, unique=True, index=True, nullable=False)
    used_at = Column(DateTime, nullable=True)
    expires_at = Column(DateTime, nullable=False)

class RequestStatus(str, enum.Enum):
    """Статусы заявки"""
    DRAFT = 'draft'
    ACTIVE = 'active'
    BIDDING_CLOSED = 'bidding_closed'
    AWAITING_CARRIER_CONFIRMATION = 'awaiting_carrier_confirmation'
    IN_PROGRESS = 'in_progress'
    COMPLETED = 'completed'
    CANCELLED = 'cancelled'
    EXPIRED = 'expired'

class Request(Base):
    """Заявка на перевозку от заказчика"""
    __tablename__ = 'requests'
    id = Column(Integer, primary_key=True, index=True)
    customer_id = Column(Integer, ForeignKey('users.id'), nullable=False, index=True)
    customer = relationship('User', foreign_keys=[customer_id])
    title = Column(String, nullable=False)
    description = Column(Text)
    from_city = Column(String, nullable=False)
    to_city = Column(String, nullable=False)
    from_address = Column(String)
    to_address = Column(String)
    distance_km = Column(Float, nullable=True)
    cargo_type = Column(String)
    cargo_weight = Column(Float)
    cargo_volume = Column(Float)
    body_type = Column(String)
    loading_date = Column(DateTime, nullable=False)
    delivery_date = Column(DateTime)
    max_price = Column(Float)
    min_price = Column(Float, nullable=True)
    is_express = Column(Boolean, default=False)
    conditions = Column(Text)
    auction_type = Column(String, default='OPEN')
    bidding_started_at = Column(DateTime, nullable=True, index=True)
    bidding_ends_at = Column(DateTime, nullable=True, index=True)
    revision = Column(Integer, default=0)
    status = Column(String, default=RequestStatus.ACTIVE.value, index=True)
    selected_carrier_id = Column(Integer, ForeignKey('users.id'), nullable=True)
    selected_carrier = relationship('User', foreign_keys=[selected_carrier_id], post_update=True, overlaps='customer')
    selected_bid_id = Column(Integer, ForeignKey('bids.id'), nullable=True)
    assigned_driver_id = Column(Integer, ForeignKey('drivers.id'), nullable=True)
    assigned_driver = relationship('Driver', foreign_keys=[assigned_driver_id])
    assigned_vehicle_id = Column(Integer, ForeignKey('vehicles.id'), nullable=True)
    assigned_vehicle = relationship('Vehicle', foreign_keys=[assigned_vehicle_id])
    contract_created_at = Column(DateTime, nullable=True)
    contract_document_path = Column(String, nullable=True)
    is_agreed = Column(Boolean, default=False)
    act_path = Column(String, nullable=True)
    signed_act_path = Column(String, nullable=True)
    act_signature_xml = Column(Text, nullable=True)
    act_signature_cert_data = Column(Text, nullable=True)
    act_number = Column(String, nullable=True)
    act_created_at = Column(DateTime, nullable=True)
    invoice_path = Column(String, nullable=True)
    invoice_number = Column(String, nullable=True)
    invoice_created_at = Column(DateTime, nullable=True)
    completion_requested_at = Column(DateTime, nullable=True)
    completion_confirmed_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, index=True)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    closed_at = Column(DateTime, nullable=True)
    bids = relationship('Bid', back_populates='request', foreign_keys='[Bid.request_id]', cascade='all, delete-orphan')
    selected_bid = relationship('Bid', foreign_keys=[selected_bid_id], post_update=True)

class Bid(Base):
    """Предложение от перевозчика на заявку"""
    __tablename__ = 'bids'
    id = Column(Integer, primary_key=True, index=True)
    request_id = Column(Integer, ForeignKey('requests.id'), nullable=False, index=True)
    request = relationship('Request', back_populates='bids', foreign_keys=[request_id])
    carrier_id = Column(Integer, ForeignKey('users.id'), nullable=False, index=True)
    carrier = relationship('User', foreign_keys=[carrier_id])
    price = Column(Float, nullable=False)
    price_per_km = Column(Float)
    delivery_time = Column(String)
    conditions = Column(Text)
    vehicle_info = Column(String)
    is_active = Column(Boolean, default=True, index=True)
    is_selected = Column(Boolean, default=False)
    is_rejected = Column(Boolean, default=False)
    revision = Column(Integer, default=0)
    created_at = Column(DateTime, default=datetime.utcnow, index=True)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

class Driver(Base):
    """Водитель"""
    __tablename__ = 'drivers'
    id = Column(Integer, primary_key=True, index=True)
    carrier_id = Column(Integer, ForeignKey('users.id'), nullable=False, index=True)
    carrier = relationship('User', foreign_keys=[carrier_id])
    full_name = Column(String, nullable=False)
    birth_date = Column(DateTime, nullable=True)
    personnel_number = Column(String, nullable=True)
    phone = Column(String, nullable=True)
    passport_type = Column(String, default='Казахстан')
    passport_series = Column(String, nullable=True)
    passport_number = Column(String, nullable=True)
    passport_issue_date = Column(DateTime, nullable=True)
    passport_issued_by = Column(String, nullable=True)
    registration_address = Column(Text, nullable=True)
    inn = Column(String, nullable=True)
    license_type = Column(String, nullable=True)
    license_series = Column(String, nullable=True)
    license_number = Column(String, nullable=True)
    license_issue_date = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, index=True)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

class Vehicle(Base):
    """Транспортное средство"""
    __tablename__ = 'vehicles'
    id = Column(Integer, primary_key=True, index=True)
    carrier_id = Column(Integer, ForeignKey('users.id'), nullable=False, index=True)
    carrier = relationship('User', foreign_keys=[carrier_id])
    vehicle_composition = Column(String(32), nullable=True, index=True)
    cargo_body_type = Column(String(32), nullable=True, index=True)
    vehicle_type = Column(String(50), nullable=True)
    actual_carrier = Column(String, default='Моя организация')
    carrier_registration_country = Column(String, default='Казахстан')
    tractor_registration = Column(String, nullable=True)
    tractor_license_plate = Column(String, nullable=True)
    tractor_brand = Column(String, nullable=True)
    trailer_registration = Column(String, nullable=True)
    trailer_license_plate = Column(String, nullable=True)
    trailer_brand = Column(String, nullable=True)
    body_type = Column(String, nullable=True)
    tonnage = Column(Float, nullable=True, index=True)
    volume = Column(Float, nullable=True)
    pallet_spaces = Column(Integer, nullable=True)
    length_m = Column(Float, nullable=True)
    width_m = Column(Float, nullable=True)
    height_m = Column(Float, nullable=True)
    temp_min_c = Column(Float, nullable=True)
    temp_max_c = Column(Float, nullable=True)
    adr_class = Column(String(32), nullable=True)
    phone = Column(String, nullable=True)
    description = Column(Text, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, index=True)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

class Notification(Base):
    """Уведомления для пользователей"""
    __tablename__ = 'notifications'
    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey('users.id'), nullable=False, index=True)
    type = Column(String, nullable=False)
    title = Column(String, nullable=False)
    message = Column(Text, nullable=False)
    request_id = Column(Integer, ForeignKey('requests.id'), nullable=True)
    bid_id = Column(Integer, ForeignKey('bids.id'), nullable=True)
    is_read = Column(Boolean, default=False, index=True)
    created_at = Column(DateTime, default=datetime.utcnow, index=True)
    user = relationship('User', foreign_keys=[user_id])
    request = relationship('Request', foreign_keys=[request_id])

class RequestHistory(Base):
    """История изменений заявки"""
    __tablename__ = 'request_history'
    id = Column(Integer, primary_key=True, index=True)
    request_id = Column(Integer, ForeignKey('requests.id'), nullable=False, index=True)
    event_type = Column(String, nullable=False)
    description = Column(Text, nullable=False)
    user_id = Column(Integer, ForeignKey('users.id'), nullable=True)
    user = relationship('User', foreign_keys=[user_id])
    event_metadata = Column(Text, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, index=True)
    request = relationship('Request', foreign_keys=[request_id])

class ContractStatus(str, enum.Enum):
    """Статусы контракта"""
    PENDING_APPROVAL = 'pending_approval'
    APPROVED = 'approved'
    DOCUMENT_UPLOADED = 'document_uploaded'
    SIGNED = 'signed'
    REJECTED = 'rejected'

class PartnershipStatus(str, enum.Enum):
    """Статусы партнерства"""
    PENDING = 'pending'
    SIGNED = 'signed'
    REJECTED = 'rejected'
    EXPIRED = 'expired'

class Partnership(Base):
    """Партнерство между компаниями"""
    __tablename__ = 'partnerships'
    id = Column(Integer, primary_key=True, index=True)
    company1_id = Column(Integer, ForeignKey('users.id'), nullable=False, index=True)
    company2_id = Column(Integer, ForeignKey('users.id'), nullable=False, index=True)
    company1 = relationship('User', foreign_keys=[company1_id])
    company2 = relationship('User', foreign_keys=[company2_id])
    status = Column(String, default=PartnershipStatus.PENDING.value, index=True)
    document_path = Column(String, nullable=True)
    signed_document_path = Column(String, nullable=True)
    signature1_xml = Column(Text, nullable=True)
    signature1_cert_data = Column(Text, nullable=True)
    signature2_xml = Column(Text, nullable=True)
    signature2_cert_data = Column(Text, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, index=True)
    signed_at = Column(DateTime, nullable=True)
    rejected_at = Column(DateTime, nullable=True)
    rejection_reason = Column(Text, nullable=True)
    expires_at = Column(DateTime, nullable=True)

class Contract(Base):
    """Контракт на перевозку"""
    __tablename__ = 'contracts'
    id = Column(Integer, primary_key=True, index=True)
    request_id = Column(Integer, ForeignKey('requests.id'), nullable=False, index=True)
    carrier_id = Column(Integer, ForeignKey('users.id'), nullable=False, index=True)
    customer_id = Column(Integer, ForeignKey('users.id'), nullable=False, index=True)
    driver_id = Column(Integer, ForeignKey('drivers.id'), nullable=False)
    vehicle_id = Column(Integer, ForeignKey('vehicles.id'), nullable=False)
    status = Column(String, default=ContractStatus.PENDING_APPROVAL.value, index=True)
    document_path = Column(String, nullable=True)
    signed_document_path = Column(String, nullable=True)
    signature_xml = Column(Text, nullable=True)
    signature_cert_data = Column(Text, nullable=True)
    power_of_attorney_path = Column(String, nullable=True)
    signed_power_of_attorney_path = Column(String, nullable=True)
    power_of_attorney_signature_xml = Column(Text, nullable=True)
    power_of_attorney_signature_cert_data = Column(Text, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, index=True)
    approved_at = Column(DateTime, nullable=True)
    document_uploaded_at = Column(DateTime, nullable=True)
    signed_at = Column(DateTime, nullable=True)
    rejected_at = Column(DateTime, nullable=True)
    rejection_reason = Column(Text, nullable=True)
    request = relationship('Request', foreign_keys=[request_id])
    carrier = relationship('User', foreign_keys=[carrier_id])
    customer = relationship('User', foreign_keys=[customer_id])
    driver = relationship('Driver', foreign_keys=[driver_id])
    vehicle = relationship('Vehicle', foreign_keys=[vehicle_id])

def init_db():
    Base.metadata.create_all(bind=engine)
    try:
        from sqlalchemy import inspect, text
        inspector = inspect(engine)
        contracts_columns = []
        requests_columns = []
        users_columns = []
        try:
            contracts_columns = [col['name'] for col in inspector.get_columns('contracts')]
        except Exception as e:
            print(f'Предупреждение: не удалось получить список колонок таблицы contracts: {e}')
        try:
            requests_columns = [col['name'] for col in inspector.get_columns('requests')]
        except Exception as e:
            print(f'Предупреждение: не удалось получить список колонок таблицы requests: {e}')
        try:
            users_columns = [col['name'] for col in inspector.get_columns('users')]
        except Exception as e:
            print(f'Предупреждение: не удалось получить список колонок таблицы users: {e}')
        vehicles_columns = []
        try:
            vehicles_columns = [col['name'] for col in inspector.get_columns('vehicles')]
        except Exception as e:
            print(f'Предупреждение: не удалось получить список колонок таблицы vehicles: {e}')
        with engine.begin() as conn:
            if 'power_of_attorney_path' not in contracts_columns:
                try:
                    conn.execute(text('ALTER TABLE contracts ADD COLUMN power_of_attorney_path VARCHAR'))
                except Exception as e:
                    print(f'Предупреждение: не удалось добавить колонку power_of_attorney_path: {e}')
            if 'signed_power_of_attorney_path' not in contracts_columns:
                try:
                    conn.execute(text('ALTER TABLE contracts ADD COLUMN signed_power_of_attorney_path VARCHAR'))
                except Exception as e:
                    print(f'Предупреждение: не удалось добавить колонку signed_power_of_attorney_path: {e}')
            if 'power_of_attorney_signature_xml' not in contracts_columns:
                try:
                    conn.execute(text('ALTER TABLE contracts ADD COLUMN power_of_attorney_signature_xml TEXT'))
                except Exception as e:
                    print(f'Предупреждение: не удалось добавить колонку power_of_attorney_signature_xml: {e}')
            if 'power_of_attorney_signature_cert_data' not in contracts_columns:
                try:
                    conn.execute(text('ALTER TABLE contracts ADD COLUMN power_of_attorney_signature_cert_data TEXT'))
                except Exception as e:
                    print(f'Предупреждение: не удалось добавить колонку power_of_attorney_signature_cert_data: {e}')
            if 'is_agreed' not in requests_columns:
                try:
                    conn.execute(text('ALTER TABLE requests ADD COLUMN is_agreed BOOLEAN DEFAULT FALSE'))
                except Exception as e:
                    print(f'Предупреждение: не удалось добавить колонку is_agreed: {e}')
            if 'act_path' not in requests_columns:
                try:
                    conn.execute(text('ALTER TABLE requests ADD COLUMN act_path VARCHAR'))
                except Exception as e:
                    print(f'Предупреждение: не удалось добавить колонку act_path: {e}')
            if 'signed_act_path' not in requests_columns:
                try:
                    conn.execute(text('ALTER TABLE requests ADD COLUMN signed_act_path VARCHAR'))
                except Exception as e:
                    print(f'Предупреждение: не удалось добавить колонку signed_act_path: {e}')
            if 'act_signature_xml' not in requests_columns:
                try:
                    conn.execute(text('ALTER TABLE requests ADD COLUMN act_signature_xml TEXT'))
                except Exception as e:
                    print(f'Предупреждение: не удалось добавить колонку act_signature_xml: {e}')
            if 'act_signature_cert_data' not in requests_columns:
                try:
                    conn.execute(text('ALTER TABLE requests ADD COLUMN act_signature_cert_data TEXT'))
                except Exception as e:
                    print(f'Предупреждение: не удалось добавить колонку act_signature_cert_data: {e}')
            if 'act_number' not in requests_columns:
                try:
                    conn.execute(text('ALTER TABLE requests ADD COLUMN act_number VARCHAR'))
                except Exception as e:
                    print(f'Предупреждение: не удалось добавить колонку act_number: {e}')
            if 'act_created_at' not in requests_columns:
                try:
                    conn.execute(text('ALTER TABLE requests ADD COLUMN act_created_at TIMESTAMP'))
                except Exception as e:
                    print(f'Предупреждение: не удалось добавить колонку act_created_at: {e}')
            if 'invoice_path' not in requests_columns:
                try:
                    conn.execute(text('ALTER TABLE requests ADD COLUMN invoice_path VARCHAR'))
                except Exception as e:
                    print(f'Предупреждение: не удалось добавить колонку invoice_path: {e}')
            if 'invoice_number' not in requests_columns:
                try:
                    conn.execute(text('ALTER TABLE requests ADD COLUMN invoice_number VARCHAR'))
                except Exception as e:
                    print(f'Предупреждение: не удалось добавить колонку invoice_number: {e}')
            if 'invoice_created_at' not in requests_columns:
                try:
                    conn.execute(text('ALTER TABLE requests ADD COLUMN invoice_created_at TIMESTAMP'))
                except Exception as e:
                    print(f'Предупреждение: не удалось добавить колонку invoice_created_at: {e}')
            user_fields = [('kpp', 'VARCHAR'), ('address', 'VARCHAR'), ('bank_name', 'VARCHAR'), ('bank_bik', 'VARCHAR'), ('bank_corr_account', 'VARCHAR'), ('bank_account', 'VARCHAR'), ('director_name', 'VARCHAR'), ('accountant_name', 'VARCHAR'), ('recipient_name', 'VARCHAR'), ('payment_currency', 'VARCHAR')]
            for field_name, field_type in user_fields:
                if field_name not in users_columns:
                    try:
                        conn.execute(text(f'ALTER TABLE users ADD COLUMN {field_name} {field_type}'))
                    except Exception as e:
                        print(f'Предупреждение: не удалось добавить колонку {field_name}: {e}')
            vehicle_fields = [('vehicle_composition', 'VARCHAR(32)'), ('cargo_body_type', 'VARCHAR(32)'), ('pallet_spaces', 'INTEGER'), ('length_m', 'REAL'), ('width_m', 'REAL'), ('height_m', 'REAL'), ('temp_min_c', 'REAL'), ('temp_max_c', 'REAL'), ('adr_class', 'VARCHAR(32)')]
            for field_name, field_type in vehicle_fields:
                if field_name not in vehicles_columns:
                    try:
                        conn.execute(text(f'ALTER TABLE vehicles ADD COLUMN {field_name} {field_type}'))
                    except Exception as e:
                        print(f'Предупреждение: не удалось добавить колонку vehicles.{field_name}: {e}')
    except Exception as e:
        print(f'Предупреждение: не удалось проверить/добавить колонки: {e}')
    try:
        from vehicle_constants import LEGACY_BODY_RU_TO_CODE, LEGACY_VEHICLE_TYPE_TO_COMPOSITION, VehicleBodyType, VehicleComposition
        sess = SessionLocal()
        try:
            for v in sess.query(Vehicle).all():
                if not getattr(v, 'vehicle_composition', None):
                    vt = (v.vehicle_type or '').strip()
                    v.vehicle_composition = LEGACY_VEHICLE_TYPE_TO_COMPOSITION.get(vt, VehicleComposition.rigid_truck.value)
                if not getattr(v, 'cargo_body_type', None):
                    bt = (v.body_type or '').strip()
                    v.cargo_body_type = LEGACY_BODY_RU_TO_CODE.get(bt, VehicleBodyType.curtain.value)
            sess.commit()
        finally:
            sess.close()
    except Exception as e:
        print(f'Предупреждение: миграция данных vehicles v2: {e}')
    try:
        from sqlalchemy import text
        with engine.begin() as conn:
            conn.execute(text('CREATE INDEX IF NOT EXISTS ix_notifications_user_unread ON notifications (user_id, is_read)'))
    except Exception as e:
        print(f'Предупреждение: не удалось создать индекс ix_notifications_user_unread: {e}')
    try:
        from sqlalchemy import text
        with engine.begin() as conn:
            conn.execute(text('CREATE INDEX IF NOT EXISTS ix_notifications_user_id_unread_only ON notifications (user_id) WHERE is_read IS FALSE'))
    except Exception as e:
        print(f'Предупреждение: ix_notifications_user_id_unread_only: {e}')
    try:
        from sqlalchemy import text
        with engine.begin() as conn:
            conn.execute(text('CREATE INDEX IF NOT EXISTS ix_requests_status_created_at ON requests (status, created_at DESC)'))
    except Exception as e:
        print(f'Предупреждение: не удалось создать индекс ix_requests_status_created_at: {e}')
    try:
        from sqlalchemy import text
        with engine.begin() as conn:
            conn.execute(text('CREATE INDEX IF NOT EXISTS ix_bids_request_id_price ON bids (request_id, price ASC)'))
    except Exception as e:
        print(f'Предупреждение: ix_bids_request_id_price: {e}')
    try:
        from sqlalchemy import text
        with engine.begin() as conn:
            conn.execute(text('CREATE INDEX IF NOT EXISTS ix_contracts_request_id_status ON contracts (request_id, status)'))
    except Exception as e:
        print(f'Предупреждение: ix_contracts_request_id_status: {e}')
    try:
        from sqlalchemy import text
        with engine.begin() as conn:
            conn.execute(text('CREATE INDEX IF NOT EXISTS ix_vehicles_vehicle_composition ON vehicles (vehicle_composition)'))
            conn.execute(text('CREATE INDEX IF NOT EXISTS ix_vehicles_cargo_body_type ON vehicles (cargo_body_type)'))
            conn.execute(text('CREATE INDEX IF NOT EXISTS ix_vehicles_tonnage ON vehicles (tonnage)'))
    except Exception as e:
        print(f'Предупреждение: индексы vehicles v2: {e}')

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
