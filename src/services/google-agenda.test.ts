import { describe, expect, it } from 'vitest';
import { ajouterMinutes } from './google-agenda';

describe('agenda Google', () => {
  it('calcule la fin du rendez-vous en heure locale', () => {
    expect(ajouterMinutes('2026-10-25T08:00', 15)).toBe('2026-10-25T08:15:00');
    expect(ajouterMinutes('2026-10-25T23:30', 60)).toBe('2026-10-26T00:30:00');
  });
});
