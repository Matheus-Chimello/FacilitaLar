const { getDistance } = require('geolib');

const radiusOptions = [1, 3, 5, 10, 20, 50];

function coordinates(latitude, longitude) {
  if (latitude === null || longitude === null || latitude === undefined || longitude === undefined || String(latitude).trim() === '' || String(longitude).trim() === '') return null;
  const point = { latitude: Number(latitude), longitude: Number(longitude) };
  return Number.isFinite(point.latitude) && Number.isFinite(point.longitude) && Math.abs(point.latitude) <= 90 && Math.abs(point.longitude) <= 180 ? point : null;
}

function locationFilter(query) {
  const point = coordinates(query.latitude, query.longitude);
  const radius = radiusOptions.includes(Number(query.radius)) ? Number(query.radius) : 1;
  return point ? { ...point, radius } : null;
}

function nearbyServices(services, location) {
  if (!location) return services;
  return services.flatMap((service) => {
    const point = coordinates(service.provider_latitude, service.provider_longitude);
    if (!point) return [];
    const distance = getDistance(location, point, 0.01);
    return distance <= location.radius * 1000 ? [{ ...service, distance }] : [];
  }).sort((a, b) => a.distance - b.distance || a.id - b.id);
}

function formatDistance(meters) {
  return meters < 1000 ? `${Math.round(meters)} m` : `${new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 }).format(meters / 1000)} km`;
}

module.exports = { coordinates, radiusOptions, locationFilter, nearbyServices, formatDistance };
