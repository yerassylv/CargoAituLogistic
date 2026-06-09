"""Справочники состава ТС и типа кузова (коды API)."""
from enum import Enum
from typing import Any, Dict, Optional

class VehicleComposition(str, Enum):
    rigid_truck = 'rigid_truck'
    tractor_semitrailer = 'tractor_semitrailer'
    truck_trailer = 'truck_trailer'
    van = 'van'
    pickup = 'pickup'
    special_vehicle = 'special_vehicle'

class VehicleBodyType(str, Enum):
    curtain = 'curtain'
    box_van = 'box_van'
    reefer = 'reefer'
    isothermal = 'isothermal'
    flatbed = 'flatbed'
    container_chassis = 'container_chassis'
    tanker = 'tanker'
    dump = 'dump'
    lowbed = 'lowbed'
COMPOSITION_LABELS_RU: Dict[str, str] = {'rigid_truck': 'Одиночный грузовик', 'tractor_semitrailer': 'Тягач + полуприцеп', 'truck_trailer': 'Грузовик + прицеп', 'van': 'Малотоннажный фургон', 'pickup': 'Пикап', 'special_vehicle': 'Спецтехника'}
BODY_TYPE_LABELS_RU: Dict[str, str] = {'curtain': 'Тент (штора)', 'box_van': 'Фургон (жёсткий кузов)', 'reefer': 'Рефрижератор', 'isothermal': 'Изотермический', 'flatbed': 'Борт / платформа', 'container_chassis': 'Контейнеровоз', 'tanker': 'Цистерна', 'dump': 'Самосвал', 'lowbed': 'Трал / низкорамник'}
LEGACY_VEHICLE_TYPE_TO_COMPOSITION = {'Сцепка': VehicleComposition.tractor_semitrailer.value, 'Тягач': VehicleComposition.tractor_semitrailer.value, 'Полуприцеп': VehicleComposition.tractor_semitrailer.value, 'Фургон': VehicleComposition.van.value}
LEGACY_BODY_RU_TO_CODE = {'Тент': VehicleBodyType.curtain.value, 'Рефрижератор': VehicleBodyType.reefer.value, 'Изотермический': VehicleBodyType.isothermal.value, 'Открытый': VehicleBodyType.flatbed.value, 'Закрытый': VehicleBodyType.box_van.value}
_COMPOSITION_VALUES = {c.value for c in VehicleComposition}
_BODY_VALUES = {b.value for b in VehicleBodyType}

def meta_vehicle_enums() -> dict:
    return {'vehicle_composition': [{'code': c.value, 'label_ru': COMPOSITION_LABELS_RU[c.value]} for c in VehicleComposition], 'cargo_body_type': [{'code': b.value, 'label_ru': BODY_TYPE_LABELS_RU[b.value]} for b in VehicleBodyType]}

def resolve_composition_code(v: Any) -> str:
    comp = getattr(v, 'vehicle_composition', None)
    if comp:
        return comp
    legacy = getattr(v, 'vehicle_type', None) or ''
    return LEGACY_VEHICLE_TYPE_TO_COMPOSITION.get(legacy, VehicleComposition.rigid_truck.value)

def resolve_body_code(v: Any) -> str:
    cb = getattr(v, 'cargo_body_type', None)
    if cb:
        return cb
    legacy = getattr(v, 'body_type', None) or ''
    return LEGACY_BODY_RU_TO_CODE.get(legacy, VehicleBodyType.curtain.value)

def vehicle_body_display_label(stored: Optional[str]) -> str:
    """Текст для UI: код кузова или устаревшая русская строка."""
    if not stored:
        return ''
    if stored in BODY_TYPE_LABELS_RU:
        return BODY_TYPE_LABELS_RU[stored]
    return stored

def vehicle_composition_display_label(stored: Optional[str]) -> str:
    if not stored:
        return ''
    if stored in COMPOSITION_LABELS_RU:
        return COMPOSITION_LABELS_RU[stored]
    return stored

def vehicle_to_response_dict(v: Any) -> Dict[str, Any]:
    comp = resolve_composition_code(v)
    body_code = resolve_body_code(v)
    legacy_vt = getattr(v, 'vehicle_type', None)
    legacy_body = getattr(v, 'body_type', None)
    comp_label = COMPOSITION_LABELS_RU.get(comp, comp)
    body_label = BODY_TYPE_LABELS_RU.get(body_code, legacy_body or body_code)
    return {'id': v.id, 'carrier_id': v.carrier_id, 'vehicle_composition': comp, 'cargo_body_type': body_code, 'composition_label_ru': comp_label, 'body_type_label_ru': body_label, 'vehicle_type': legacy_vt or comp_label, 'actual_carrier': v.actual_carrier, 'carrier_registration_country': v.carrier_registration_country, 'tractor_registration': v.tractor_registration, 'tractor_license_plate': v.tractor_license_plate, 'tractor_brand': v.tractor_brand, 'trailer_registration': v.trailer_registration, 'trailer_license_plate': v.trailer_license_plate, 'trailer_brand': v.trailer_brand, 'body_type': legacy_body or body_label, 'tonnage': v.tonnage, 'volume': v.volume, 'pallet_spaces': getattr(v, 'pallet_spaces', None), 'length_m': getattr(v, 'length_m', None), 'width_m': getattr(v, 'width_m', None), 'height_m': getattr(v, 'height_m', None), 'temp_min_c': getattr(v, 'temp_min_c', None), 'temp_max_c': getattr(v, 'temp_max_c', None), 'adr_class': getattr(v, 'adr_class', None), 'phone': v.phone, 'description': v.description, 'created_at': v.created_at, 'updated_at': v.updated_at}

def validate_composition_and_body_codes(composition: str, body: str) -> None:
    if composition not in _COMPOSITION_VALUES:
        raise ValueError(f'Неизвестный vehicle_composition: {composition}. Допустимо: {sorted(_COMPOSITION_VALUES)}')
    if body not in _BODY_VALUES:
        raise ValueError(f'Неизвестный cargo_body_type: {body}. Допустимо: {sorted(_BODY_VALUES)}')

def persist_labels_from_codes(vehicle_composition: str, cargo_body_type: str) -> tuple:
    """Значения для устаревших колонок vehicle_type / body_type (русские подписи)."""
    vt = COMPOSITION_LABELS_RU.get(vehicle_composition, vehicle_composition)
    bt = BODY_TYPE_LABELS_RU.get(cargo_body_type, cargo_body_type)
    return (vt, bt)
