from pydantic import BaseModel, Field, field_validator, model_validator
from typing import Optional, List
from datetime import datetime

class NonceResponse(BaseModel):
    """Ответ с одноразовым nonce для подписи"""
    nonce: str
    expires_at: datetime

class CertificateData(BaseModel):
    """Данные сертификата из NCALayer"""
    iin: str = Field(..., description='ИИН физического лица')
    full_name: str = Field(..., description='ФИО')
    serial_number: str = Field(..., description='Серийный номер сертификата')
    issuer: Optional[str] = Field(None, description='Издатель сертификата')
    valid_from: Optional[datetime] = Field(None, description='Действителен с')
    valid_to: Optional[datetime] = Field(None, description='Действителен до')
    email: Optional[str] = Field(None, description='Email из сертификата')
    company_name: Optional[str] = Field(None, description='Название компании')

class VerifyRequest(BaseModel):
    """Запрос на верификацию подписи"""
    signedXml: str = Field(..., description='Подписанный XML документ')

class UserResponse(BaseModel):
    """Данные пользователя"""
    id: int
    iin: str
    bin: Optional[str] = None
    full_name: str
    email: Optional[str]
    company_name: Optional[str]
    phone: Optional[str]
    cert_serial: Optional[str]
    created_at: datetime
    last_login: Optional[datetime]

    class Config:
        from_attributes = True

class AuthResponse(BaseModel):
    """Ответ на авторизацию/регистрацию"""
    success: bool
    message: str
    user: Optional[UserResponse] = None
    is_new_user: bool = False

class UserRegistration(BaseModel):
    email: Optional[str] = None
    full_name: str = Field(..., min_length=2, max_length=100)
    company_name: Optional[str] = Field(None, max_length=200)
    phone: Optional[str] = Field(None, max_length=20)
    inn: Optional[str] = Field(None, max_length=12, description='ИНН организации')

class RegistrationResponse(BaseModel):
    success: bool
    message: str
    user: Optional[UserResponse] = None

class RequestCreate(BaseModel):
    """Создание новой заявки"""
    title: str = Field(..., min_length=3, max_length=200)
    description: Optional[str] = None
    from_city: str = Field(..., min_length=2, max_length=100)
    to_city: str = Field(..., min_length=2, max_length=100)
    from_address: Optional[str] = None
    to_address: Optional[str] = None
    distance_km: Optional[float] = None
    cargo_type: Optional[str] = None
    cargo_weight: Optional[float] = None
    cargo_volume: Optional[float] = None
    body_type: Optional[str] = None
    loading_date: datetime
    delivery_date: Optional[datetime] = None
    max_price: Optional[float] = None
    min_price: Optional[float] = None
    is_express: bool = False
    conditions: Optional[str] = None
    auction_type: str = 'OPEN'
    bidding_started_at: Optional[datetime] = None
    bidding_ends_at: Optional[datetime] = None

    @field_validator('bidding_started_at', 'bidding_ends_at', mode='before')
    @classmethod
    def empty_bidding_dt_to_none(cls, v):
        if v == '' or v is None:
            return None
        return v

    @field_validator('delivery_date', mode='before')
    @classmethod
    def empty_string_to_none(cls, v):
        """Преобразует пустые строки в None для опциональной даты доставки"""
        if v == '' or v is None:
            return None
        return v

    @field_validator('loading_date', mode='before')
    @classmethod
    def validate_loading_date(cls, v):
        """Валидация обязательной даты погрузки"""
        if v == '':
            raise ValueError('Дата погрузки обязательна для заполнения')
        return v

class RequestResponse(BaseModel):
    """Ответ с данными заявки"""
    id: int
    customer_id: int
    title: str
    description: Optional[str]
    from_city: str
    to_city: str
    from_address: Optional[str]
    to_address: Optional[str]
    distance_km: Optional[float] = None
    cargo_type: Optional[str]
    cargo_weight: Optional[float]
    cargo_volume: Optional[float]
    body_type: Optional[str]
    loading_date: datetime
    delivery_date: Optional[datetime]
    max_price: Optional[float]
    min_price: Optional[float] = None
    is_express: bool
    conditions: Optional[str]
    auction_type: str = 'OPEN'
    bidding_started_at: Optional[datetime] = None
    bidding_ends_at: Optional[datetime] = None
    bidding_accepting: Optional[bool] = None
    revision: int = 0
    status: str
    selected_carrier_id: Optional[int] = None
    selected_carrier_company_name: Optional[str] = None
    selected_carrier_full_name: Optional[str] = None
    selected_carrier_phone: Optional[str] = None
    selected_carrier_iin: Optional[str] = None
    selected_bid_id: Optional[int] = None
    assigned_driver_id: Optional[int] = None
    assigned_vehicle_id: Optional[int] = None
    contract_created_at: Optional[datetime] = None
    created_at: datetime
    updated_at: datetime
    customer_name: Optional[str] = None
    bids_count: int = 0
    assigned_driver_name: Optional[str] = None
    assigned_driver_phone: Optional[str] = None
    assigned_driver_birth_date: Optional[datetime] = None
    assigned_vehicle_info: Optional[str] = None
    assigned_vehicle_model: Optional[str] = None
    assigned_vehicle_type: Optional[str] = None
    user_has_bid: bool = False
    act_path: Optional[str] = None
    signed_act_path: Optional[str] = None
    act_signature_xml: Optional[str] = None
    act_signature_cert_data: Optional[str] = None
    act_number: Optional[str] = None
    act_created_at: Optional[datetime] = None
    invoice_path: Optional[str] = None
    invoice_number: Optional[str] = None
    invoice_created_at: Optional[datetime] = None
    is_agreed: Optional[bool] = False
    completion_requested_at: Optional[datetime] = None
    completion_confirmed_at: Optional[datetime] = None

    class Config:
        from_attributes = True

class BidCreate(BaseModel):
    """Создание предложения от перевозчика"""
    price: float = Field(..., gt=0)
    price_per_km: Optional[float] = None
    delivery_time: Optional[str] = None
    conditions: Optional[str] = None
    vehicle_info: Optional[str] = None

class BidUpdate(BaseModel):
    """Обновление предложения от перевозчика"""
    price: Optional[float] = Field(None, gt=0)
    price_per_km: Optional[float] = None
    delivery_time: Optional[str] = None
    conditions: Optional[str] = None
    vehicle_info: Optional[str] = None

class BidResponse(BaseModel):
    """Ответ с данными предложения"""
    id: int
    request_id: int
    carrier_id: int
    price: float
    price_per_km: Optional[float]
    delivery_time: Optional[str]
    conditions: Optional[str]
    vehicle_info: Optional[str]
    is_active: bool
    is_selected: bool
    is_rejected: bool
    revision: int = 0
    created_at: datetime
    updated_at: datetime
    carrier_name: Optional[str] = None
    carrier_company: Optional[str] = None

    class Config:
        from_attributes = True

class RequestResponseWithBids(RequestResponse):
    """Заявка + список ставок (GET /requests/{id}?include_bids=1) — один HTTP round-trip."""
    bids: List[BidResponse] = Field(default_factory=list)

class DriverCreate(BaseModel):
    """Создание водителя"""
    full_name: str = Field(..., min_length=3, max_length=200)
    birth_date: Optional[datetime] = None
    personnel_number: Optional[str] = None
    phone: Optional[str] = None
    passport_type: str = 'Казахстан'
    passport_series: Optional[str] = None
    passport_number: Optional[str] = None
    passport_issue_date: Optional[datetime] = None
    passport_issued_by: Optional[str] = None
    registration_address: Optional[str] = None
    inn: Optional[str] = None
    license_type: Optional[str] = None
    license_series: Optional[str] = None
    license_number: Optional[str] = None
    license_issue_date: Optional[datetime] = None

class DriverResponse(BaseModel):
    """Ответ с данными водителя"""
    id: int
    carrier_id: int
    full_name: str
    birth_date: Optional[datetime]
    personnel_number: Optional[str]
    phone: Optional[str]
    passport_type: str
    passport_series: Optional[str]
    passport_number: Optional[str]
    passport_issue_date: Optional[datetime]
    passport_issued_by: Optional[str]
    registration_address: Optional[str]
    inn: Optional[str]
    license_type: Optional[str]
    license_series: Optional[str]
    license_number: Optional[str]
    license_issue_date: Optional[datetime]
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True

class VehicleCreate(BaseModel):
    """Создание транспортного средства (коды composition + cargo_body_type или устаревшие поля)."""
    vehicle_composition: Optional[str] = Field(None, description='Код состава, см. GET /api/meta/vehicle-enums')
    cargo_body_type: Optional[str] = Field(None, description='Код типа кузова')
    vehicle_type: Optional[str] = Field(None, description='Устарело: Сцепка, Тягач, Фургон, Полуприцеп')
    actual_carrier: str = 'Моя организация'
    carrier_registration_country: str = 'Казахстан'
    tractor_registration: Optional[str] = None
    tractor_license_plate: Optional[str] = None
    tractor_brand: Optional[str] = None
    trailer_registration: Optional[str] = None
    trailer_license_plate: Optional[str] = None
    trailer_brand: Optional[str] = None
    body_type: Optional[str] = Field(None, description='Устарело: русское название кузова из старой формы')
    tonnage: Optional[float] = None
    volume: Optional[float] = None
    pallet_spaces: Optional[int] = None
    length_m: Optional[float] = None
    width_m: Optional[float] = None
    height_m: Optional[float] = None
    temp_min_c: Optional[float] = None
    temp_max_c: Optional[float] = None
    adr_class: Optional[str] = None
    phone: Optional[str] = None
    description: Optional[str] = None

    @model_validator(mode='after')
    def infer_composition_from_legacy(self):
        from vehicle_constants import LEGACY_BODY_RU_TO_CODE, LEGACY_VEHICLE_TYPE_TO_COMPOSITION, VehicleBodyType, VehicleComposition, validate_composition_and_body_codes
        vc = self.vehicle_composition
        cb = self.cargo_body_type
        if vc and cb:
            validate_composition_and_body_codes(vc, cb)
            return self
        if self.vehicle_type:
            self.vehicle_composition = LEGACY_VEHICLE_TYPE_TO_COMPOSITION.get(self.vehicle_type, VehicleComposition.rigid_truck.value)
            if self.body_type:
                self.cargo_body_type = LEGACY_BODY_RU_TO_CODE.get(self.body_type, VehicleBodyType.curtain.value)
            else:
                self.cargo_body_type = VehicleBodyType.curtain.value
            validate_composition_and_body_codes(self.vehicle_composition, self.cargo_body_type)
            return self
        raise ValueError('Укажите vehicle_composition и cargo_body_type или устаревшие vehicle_type (и при необходимости body_type)')

class VehicleResponse(BaseModel):
    """Ответ с данными транспортного средства"""
    id: int
    carrier_id: int
    vehicle_composition: str
    cargo_body_type: str
    composition_label_ru: str
    body_type_label_ru: str
    vehicle_type: Optional[str] = None
    actual_carrier: str
    carrier_registration_country: str
    tractor_registration: Optional[str]
    tractor_license_plate: Optional[str]
    tractor_brand: Optional[str]
    trailer_registration: Optional[str]
    trailer_license_plate: Optional[str]
    trailer_brand: Optional[str]
    body_type: Optional[str]
    tonnage: Optional[float]
    volume: Optional[float]
    pallet_spaces: Optional[int] = None
    length_m: Optional[float] = None
    width_m: Optional[float] = None
    height_m: Optional[float] = None
    temp_min_c: Optional[float] = None
    temp_max_c: Optional[float] = None
    adr_class: Optional[str] = None
    phone: Optional[str]
    description: Optional[str]
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True

class NotificationResponse(BaseModel):
    """Ответ с уведомлением"""
    id: int
    type: str
    title: str
    message: str
    request_id: Optional[int] = None
    bid_id: Optional[int] = None
    is_read: bool
    created_at: datetime

    class Config:
        from_attributes = True

class RequestHistoryResponse(BaseModel):
    """Ответ с записью истории изменений заявки"""
    id: int
    request_id: int
    event_type: str
    description: str
    user_id: Optional[int] = None
    user_name: Optional[str] = None
    metadata: Optional[str] = None
    created_at: datetime

    class Config:
        from_attributes = True

class ContractResponse(BaseModel):
    """Ответ с данными контракта"""
    id: int
    request_id: int
    carrier_id: int
    customer_id: int
    driver_id: int
    vehicle_id: int
    status: str
    document_path: Optional[str] = None
    signed_document_path: Optional[str] = None
    signature_xml: Optional[str] = None
    signature_cert_data: Optional[str] = None
    created_at: datetime
    approved_at: Optional[datetime] = None
    document_uploaded_at: Optional[datetime] = None
    signed_at: Optional[datetime] = None
    rejected_at: Optional[datetime] = None
    rejection_reason: Optional[str] = None
    power_of_attorney_path: Optional[str] = None
    signed_power_of_attorney_path: Optional[str] = None
    power_of_attorney_signature_xml: Optional[str] = None
    power_of_attorney_signature_cert_data: Optional[str] = None
    driver_name: Optional[str] = None
    vehicle_info: Optional[str] = None
    carrier_name: Optional[str] = None
    customer_name: Optional[str] = None

    class Config:
        from_attributes = True

class PartnershipResponse(BaseModel):
    """Ответ с данными партнерства"""
    id: int
    company1_id: int
    company2_id: int
    company1_name: Optional[str] = None
    company2_name: Optional[str] = None
    status: str
    document_path: Optional[str] = None
    signed_document_path: Optional[str] = None
    created_at: datetime
    signed_at: Optional[datetime] = None
    rejected_at: Optional[datetime] = None
    rejection_reason: Optional[str] = None
    expires_at: Optional[datetime] = None

    class Config:
        from_attributes = True

class PartnershipCreate(BaseModel):
    """Создание запроса на партнерство"""
    company2_id: int = Field(..., description='ID компании, с которой хотим заключить партнерство')

class PartnershipSign(BaseModel):
    """Подписание договора партнерства"""
    signed_xml: str = Field(..., description='Подписанный XML документ')
    nonce: str = Field(..., description='Одноразовый nonce для защиты от replay-атак')

class OrganizationResponse(BaseModel):
    """Данные организации для списка"""
    id: Optional[int] = None
    company_name: Optional[str] = None
    full_name: str
    bin: Optional[str] = None
    email: Optional[str] = None
    phone: Optional[str] = None
    address: Optional[str] = None
    has_partnership: bool = False
    partnership_status: Optional[str] = None
    partnership_id: Optional[int] = None
    partnership_my_signature_done: Optional[bool] = None
    partnership_signed_at: Optional[datetime] = None
    is_registered: bool = False

    class Config:
        from_attributes = True

class PaymentDetailsUpdate(BaseModel):
    """Обновление платёжных реквизитов"""
    iin: Optional[str] = Field(None, max_length=12, description='БИН компании для валидации через data.egov.kz')
    recipient_name: str = Field(..., min_length=1, max_length=200, description='Получатель (ФИО / ТОО / ИП)')
    bank_name: str = Field(..., min_length=1, max_length=200, description='Банк получателя')
    bank_bik: str = Field(..., min_length=1, max_length=50, description='БИК')
    bank_account: str = Field(..., min_length=1, max_length=100, description='Расчётный счёт (IBAN / Р/С)')
    bank_corr_account: Optional[str] = Field(None, max_length=100, description='Корр. счёт')
    kpp: Optional[str] = Field(None, max_length=20, description='КПП (если РФ)')
    payment_currency: Optional[str] = Field('KZT', max_length=10, description='Валюта (KZT, RUB, USD и т.д.)')
    address: Optional[str] = Field(None, max_length=500, description='Адрес')
    director_name: Optional[str] = Field(None, max_length=200, description='ФИО руководителя')
    accountant_name: Optional[str] = Field(None, max_length=200, description='ФИО бухгалтера')
