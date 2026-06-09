let createRequestMap = null;

let detailRequestMap = null;

let directionsService = null;

let directionsRenderer = null;

let detailDirectionsService = null;

let detailDirectionsRenderer = null;

let googleMapsLoaded = false;

window.googleMapsLoaded = false;

let mapsCoreInitialized = false;

function initGoogleMaps() {
    googleMapsLoaded = true;
    window.googleMapsLoaded = true;
    console.log("Google Maps загружен");
    if (!mapsCoreInitialized) {
        mapsCoreInitialized = true;
        directionsService = new google.maps.DirectionsService;
        directionsRenderer = new google.maps.DirectionsRenderer({
            suppressMarkers: false,
            preserveViewport: false,
            polylineOptions: {
                strokeColor: "#0066cc",
                strokeWeight: 5,
                strokeOpacity: .8
            }
        });
        detailDirectionsService = new google.maps.DirectionsService;
        detailDirectionsRenderer = new google.maps.DirectionsRenderer({
            suppressMarkers: false,
            preserveViewport: false,
            polylineOptions: {
                strokeColor: "#0066cc",
                strokeWeight: 5,
                strokeOpacity: .8
            }
        });
    }
}

function initCreateRequestMap() {
    const mapContainer = document.getElementById("createRequestMap");
    if (!mapContainer) {
        setTimeout(initCreateRequestMap, 500);
        return;
    }
    if (createRequestMap) {
        return;
    }
    try {
        const ph = document.getElementById("createRequestMapPlaceholder");
        if (ph) {
            ph.style.display = "none";
        }
        createRequestMap = new google.maps.Map(mapContainer, {
            center: {
                lat: 51.1694,
                lng: 71.4491
            },
            zoom: 6,
            mapTypeControl: true,
            streetViewControl: false,
            fullscreenControl: true
        });
        directionsRenderer.setMap(createRequestMap);
    } catch (error) {
        console.error("Ошибка инициализации карты создания заявки:", error);
    }
}

function initDetailRequestMap(fromCity, toCity, fromAddress, toAddress) {
    const mapContainer = document.getElementById("detailRequestMap");
    if (!mapContainer) {
        console.warn("Контейнер карты не найден");
        return;
    }
    try {
        if (detailRequestMap) {
            updateDetailRoute(fromCity, toCity, fromAddress, toAddress);
            return;
        }
        detailRequestMap = new google.maps.Map(mapContainer, {
            center: {
                lat: 51.1694,
                lng: 71.4491
            },
            zoom: 6,
            mapTypeControl: true,
            streetViewControl: false,
            fullscreenControl: true
        });
        detailDirectionsRenderer.setMap(detailRequestMap);
        updateDetailRoute(fromCity, toCity, fromAddress, toAddress);
    } catch (error) {
        console.error("Ошибка инициализации карты детального просмотра:", error);
    }
}

function updateCreateRequestRoute() {
    if (!createRequestMap || !directionsService || !directionsRenderer) return;
    const fromCity = document.getElementById("requestFromCity")?.value?.trim();
    const toCity = document.getElementById("requestToCity")?.value?.trim();
    const fromAddress = document.getElementById("requestFromAddress")?.value?.trim();
    const toAddress = document.getElementById("requestToAddress")?.value?.trim();
    if (!fromCity || !toCity) {
        createRequestMap.setCenter({
            lat: 51.1694,
            lng: 71.4491
        });
        createRequestMap.setZoom(6);
        directionsRenderer.setDirections({
            routes: []
        });
        hideRouteInfo("createRequestMap");
        return;
    }
    let origin = fromCity;
    let destination = toCity;
    if (fromAddress) {
        origin = `${fromAddress}, ${fromCity}`;
    }
    if (toAddress) {
        destination = `${toAddress}, ${toCity}`;
    }
    if (!origin.includes("Казахстан") && !origin.includes("Kazakhstan")) {
        origin += ", Казахстан";
    }
    if (!destination.includes("Казахстан") && !destination.includes("Kazakhstan")) {
        destination += ", Казахстан";
    }
    directionsService.route({
        origin: origin,
        destination: destination,
        travelMode: google.maps.TravelMode.DRIVING,
        language: "ru",
        unitSystem: google.maps.UnitSystem.METRIC
    }, (result, status) => {
        if (status === "OK") {
            directionsRenderer.setDirections(result);
            const route = result.routes[0];
            const leg = route.legs[0];
            const distance = leg.distance.text;
            const duration = leg.duration.text;
            showRouteInfo("createRequestMap", distance, duration, fromCity, toCity);
            console.log(`Расстояние: ${distance}, Время: ${duration}`);
        } else {
            console.error("Ошибка построения маршрута:", status);
            showCitiesMarkersOnly(createRequestMap, fromCity, toCity);
            hideRouteInfo("createRequestMap");
            const errorMsg = getDirectionsErrorMessage(status);
            if (errorMsg) {
                showRouteError("createRequestMap", errorMsg);
            }
        }
    });
}

function updateDetailRoute(fromCity, toCity, fromAddress, toAddress) {
    if (!detailRequestMap || !detailDirectionsService || !detailDirectionsRenderer) return;
    if (!fromCity || !toCity) {
        detailRequestMap.setCenter({
            lat: 51.1694,
            lng: 71.4491
        });
        detailRequestMap.setZoom(6);
        detailDirectionsRenderer.setDirections({
            routes: []
        });
        hideRouteInfo("detailRequestMap");
        return;
    }
    let origin = fromCity;
    let destination = toCity;
    if (fromAddress) {
        origin = `${fromAddress}, ${fromCity}`;
    }
    if (toAddress) {
        destination = `${toAddress}, ${toCity}`;
    }
    if (!origin.includes("Казахстан") && !origin.includes("Kazakhstan")) {
        origin += ", Казахстан";
    }
    if (!destination.includes("Казахстан") && !destination.includes("Kazakhstan")) {
        destination += ", Казахстан";
    }
    detailDirectionsService.route({
        origin: origin,
        destination: destination,
        travelMode: google.maps.TravelMode.DRIVING,
        language: "ru",
        unitSystem: google.maps.UnitSystem.METRIC,
        avoidHighways: false,
        avoidTolls: false,
        optimizeWaypoints: false
    }, (result, status) => {
        if (status === "OK") {
            detailDirectionsRenderer.setDirections(result);
            const route = result.routes[0];
            const leg = route.legs[0];
            const distance = leg.distance.text;
            const duration = leg.duration.text;
            showRouteInfo("detailRequestMap", distance, duration, fromCity, toCity);
            console.log(`Расстояние: ${distance}, Время: ${duration}`);
        } else {
            console.error("Ошибка построения маршрута:", status);
            showCitiesMarkersOnly(detailRequestMap, fromCity, toCity);
            hideRouteInfo("detailRequestMap");
            const errorMsg = getDirectionsErrorMessage(status);
            if (errorMsg) {
                showRouteError("detailRequestMap", errorMsg);
            }
        }
    });
}

let cityMarkers = [];

function showCitiesMarkersOnly(map, fromCity, toCity) {
    cityMarkers.forEach(marker => marker.setMap(null));
    cityMarkers = [];
    const geocoder = new google.maps.Geocoder;
    const geocodeCity = (city, callback) => {
        const cityWithCountry = city.includes("Казахстан") ? city : `${city}, Казахстан`;
        geocoder.geocode({
            address: cityWithCountry
        }, (results, status) => {
            if (status === "OK" && results[0]) {
                callback(results[0].geometry.location);
            } else {
                callback(null);
            }
        });
    };
    geocodeCity(fromCity, fromLocation => {
        geocodeCity(toCity, toLocation => {
            if (fromLocation && toLocation) {
                const fromMarker = new google.maps.Marker({
                    position: fromLocation,
                    map: map,
                    title: fromCity,
                    label: {
                        text: "A",
                        color: "#ffffff",
                        fontWeight: "bold"
                    },
                    icon: {
                        url: "http://maps.google.com/mapfiles/ms/icons/blue-dot.png"
                    }
                });
                const toMarker = new google.maps.Marker({
                    position: toLocation,
                    map: map,
                    title: toCity,
                    label: {
                        text: "B",
                        color: "#ffffff",
                        fontWeight: "bold"
                    },
                    icon: {
                        url: "http://maps.google.com/mapfiles/ms/icons/red-dot.png"
                    }
                });
                cityMarkers.push(fromMarker, toMarker);
                const bounds = new google.maps.LatLngBounds;
                bounds.extend(fromLocation);
                bounds.extend(toLocation);
                map.fitBounds(bounds);
            }
        });
    });
}

function getDirectionsErrorMessage(status) {
    const errorMessages = {
        ZERO_RESULTS: "Маршрут не найден. Проверьте правильность названий городов.",
        NOT_FOUND: "Один из городов не найден. Проверьте правильность написания.",
        OVER_QUERY_LIMIT: "Превышен лимит запросов к Google Maps API. Попробуйте позже.",
        REQUEST_DENIED: "Запрос отклонен. Проверьте настройки Google Maps API ключа.",
        INVALID_REQUEST: "Некорректный запрос. Проверьте введенные данные.",
        UNKNOWN_ERROR: "Неизвестная ошибка. Попробуйте обновить страницу."
    };
    return errorMessages[status] || `Ошибка построения маршрута: ${status}`;
}

function showRouteError(mapContainerId, errorMessage) {
    const mapContainer = document.getElementById(mapContainerId);
    if (!mapContainer) return;
    const parent = mapContainer.parentElement;
    const oldError = parent.querySelector(".route-error");
    if (oldError) {
        oldError.remove();
    }
    const errorInfo = document.createElement("div");
    errorInfo.className = "route-error";
    errorInfo.style.cssText = `\n    margin-top: 10px;\n    padding: 12px 16px;\n    background: #fff3cd;\n    border: 1px solid #ffc107;\n    border-radius: 8px;\n    color: #856404;\n    font-size: 13px;\n    display: flex;\n    align-items: center;\n    gap: 8px;\n  `;
    errorInfo.innerHTML = `\n    <span>${errorMessage}</span>\n  `;
    mapContainer.parentElement.insertBefore(errorInfo, mapContainer.nextSibling);
}

function showRouteInfo(mapContainerId, distance, duration, fromCity, toCity) {
    const mapContainer = document.getElementById(mapContainerId);
    if (!mapContainer) return;
    const parent = mapContainer.parentElement;
    const oldInfo = parent.querySelector(".route-info");
    if (oldInfo) {
        oldInfo.remove();
    }
    const routeInfo = document.createElement("div");
    routeInfo.className = "route-info";
    routeInfo.style.cssText = `\n    margin-top: 10px;\n    padding: 12px 16px;\n    background: #f0f9ff;\n    border: 1px solid #4a90e2;\n    border-radius: 8px;\n    display: flex;\n    align-items: center;\n    gap: 15px;\n    font-size: 14px;\n  `;
    routeInfo.innerHTML = `\n    <div style="flex: 1;">\n      <div style="font-weight: 600; color: #1a1a1a; margin-bottom: 4px;">\n        <span>${fromCity} → ${toCity}</span>\n      </div>\n      <div style="display: flex; gap: 20px; color: #666; font-size: 13px; flex-wrap: wrap;">\n        <span>\n          Расстояние: <strong style="color: #0066cc;">${distance}</strong>\n        </span>\n        ${duration !== "-" ? `<span>\n          Время в пути: <strong style="color: #0066cc;">${duration}</strong>\n        </span>` : ""}\n      </div>\n    </div>\n  `;
    mapContainer.parentElement.insertBefore(routeInfo, mapContainer.nextSibling);
}

function hideRouteInfo(mapContainerId) {
    const mapContainer = document.getElementById(mapContainerId);
    if (!mapContainer) return;
    const routeInfo = mapContainer.parentElement.querySelector(".route-info");
    if (routeInfo) {
        routeInfo.remove();
    }
}

let createMapListenersBound = false;

function setupMapListeners() {
    if (createMapListenersBound) {
        return;
    }
    createMapListenersBound = true;
    const fromCityInput = document.getElementById("requestFromCity");
    const toCityInput = document.getElementById("requestToCity");
    const fromAddressInput = document.getElementById("requestFromAddress");
    const toAddressInput = document.getElementById("requestToAddress");
    let updateTimeout;
    const updateMap = () => {
        clearTimeout(updateTimeout);
        updateTimeout = setTimeout(() => {
            updateCreateRequestRoute();
        }, 500);
    };
    if (fromCityInput) {
        fromCityInput.addEventListener("input", updateMap);
    }
    if (toCityInput) {
        toCityInput.addEventListener("input", updateMap);
    }
    if (fromAddressInput) {
        fromAddressInput.addEventListener("input", updateMap);
    }
    if (toAddressInput) {
        toAddressInput.addEventListener("input", updateMap);
    }
}

window.initGoogleMaps = initGoogleMaps;

window.initDetailRequestMap = initDetailRequestMap;

window.updateCreateRequestRoute = updateCreateRequestRoute;

window.setupMapListeners = setupMapListeners;

window.initCreateRequestMap = initCreateRequestMap;