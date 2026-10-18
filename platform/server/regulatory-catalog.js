import fs from 'node:fs';
import { ApiError } from './errors.js';

export function readRegulatoryCatalog(config) {
  let catalog;
  try { catalog = JSON.parse(fs.readFileSync(config.regulatoryPath, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return { available: false, checkedAt: null, sources: [] };
    throw new ApiError(503, 'REGULATORY_CATALOG_UNAVAILABLE', 'Справочник нормативных источников временно недоступен.');
  }
  if (!catalog || !Array.isArray(catalog.sources)) throw new ApiError(503, 'REGULATORY_CATALOG_UNAVAILABLE', 'Справочник нормативных источников временно недоступен.');
  return { ...catalog, available: true, checkedAt: catalog.checkedAt ?? null };
}
