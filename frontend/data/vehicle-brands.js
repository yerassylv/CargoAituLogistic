(function() {
    window.TRACTOR_BRANDS = [ "DAF", "Dongfeng", "FAW", "Ford Trucks", "Howo", "International", "Iveco", "MAN", "Mercedes-Benz", "Renault Trucks", "Scania", "Shacman", "Sitrak", "Volvo", "КамАЗ", "МАЗ" ].sort(function(a, b) {
        return a.localeCompare(b, "ru");
    });
    window.TRAILER_BRANDS = [ "Berdex", "Benalu", "Cardi", "Chereau", "Fliegl", "Fruehauf", "Gray & Adams", "Humbaur", "Kogel", "Kögel", "Krone", "Kässbohrer", "Lamberet", "Lecitrailer", "Montracon", "Pacton", "Panus", "Schmitz Cargobull", "Schwarzmüller", "Trailmobil", "Wielton", "Тонар" ].sort(function(a, b) {
        return a.localeCompare(b, "ru");
    });
    window.BRAND_SELECT_OTHER = "__other__";
})();