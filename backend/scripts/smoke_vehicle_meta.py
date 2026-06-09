"""Смоук: справочник vehicle-enums (без запущенного HTTP-сервера)."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from vehicle_constants import meta_vehicle_enums

def main():
    m = meta_vehicle_enums()
    assert 'vehicle_composition' in m and 'cargo_body_type' in m
    assert len(m['vehicle_composition']) >= 1
    assert len(m['cargo_body_type']) >= 1
    print('smoke_vehicle_meta OK:', len(m['vehicle_composition']), 'compositions,', len(m['cargo_body_type']), 'body types')
if __name__ == '__main__':
    main()
