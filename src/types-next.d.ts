// lib/agenda.ts passe l'option de cache propre à Next.js à fetch ; hors de Next, on la déclare.
interface RequestInit {
  next?: { revalidate?: number | false; tags?: string[] };
}
