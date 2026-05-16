// Translation tables for the tablet kiosk. Add a new key here, then use
// t(lang, "key") in the UI. Falls back to English if a key is missing.

export type TabletLang = "en" | "es";

export const TABLET_LANGS: { code: TabletLang; label: string; flag: string }[] = [
  { code: "en", label: "English",  flag: "🇬🇧" },
  { code: "es", label: "Español", flag: "🇪🇸" },
];

type Dict = Record<string, string>;

const STRINGS: Record<TabletLang, Dict> = {
  en: {
    enter_pin:           "Enter PIN",
    invalid_pin:         "Wrong PIN, try again",
    invalid_token:       "Unknown device",
    invalid_token_hint:  "This tablet link is not assigned to a machine.",
    loading:             "Loading…",

    cell:                "Cell",
    rank:                "Rank",
    machine:             "Machine",
    bu:                  "BU",
    uptime:              "Uptime",
    no_peers:            "No other machines in this cell.",

    status_running:      "Running",
    status_idle:         "Idle",
    status_offline:      "Offline",
    error_header:        "Error",
    cause:               "Cause",
    solution:            "Solution",
    no_active_errors:    "Waiting for error details…",

    language:            "Language",
  },
  es: {
    enter_pin:           "Ingrese PIN",
    invalid_pin:         "PIN incorrecto, intente de nuevo",
    invalid_token:       "Dispositivo desconocido",
    invalid_token_hint:  "Este enlace de tableta no está asignado a una máquina.",
    loading:             "Cargando…",

    cell:                "Celda",
    rank:                "Posición",
    machine:             "Máquina",
    bu:                  "BU",
    uptime:              "Tiempo activo",
    no_peers:            "No hay otras máquinas en esta celda.",

    status_running:      "En marcha",
    status_idle:         "Inactiva",
    status_offline:      "Desconectada",
    error_header:        "Error",
    cause:               "Causa",
    solution:            "Solución",
    no_active_errors:    "Esperando detalles del error…",

    language:            "Idioma",
  },
};

export function t(lang: TabletLang, key: string): string {
  return STRINGS[lang][key] ?? STRINGS.en[key] ?? key;
}
