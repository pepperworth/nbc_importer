import { EdumapsImporter } from './edumaps.js';
import { TaskcardsImporter } from './taskcards.js';
import { PadletImporter } from './padlet.js';

export const IMPORTERS = [
  new TaskcardsImporter(),
  new PadletImporter(),
  new EdumapsImporter(),
];

export function findImporter(url) {
  return IMPORTERS.find(i => i.matches(url)) || null;
}

export function findImporterByName(name) {
  return IMPORTERS.find(i => i.name === name) || null;
}
