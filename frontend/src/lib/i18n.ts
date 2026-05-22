// Translation tables for the tablet kiosk. Add a new key here, then use
// t(lang, "key") in the UI. Falls back to English if a key is missing.

export type TabletLang = "en" | "es" | "ar";

export const TABLET_LANGS: { code: TabletLang; label: string; flag: string }[] = [
  { code: "en", label: "English",  flag: "🇬🇧" },
  { code: "es", label: "Español", flag: "🇪🇸" },
  { code: "ar", label: "العربية", flag: "🇸🇦" },
];

// Languages that read right-to-left. The kiosk flips its layout (dir="rtl")
// when one of these is selected.
export const RTL_LANGS: ReadonlyArray<TabletLang> = ["ar"];

export function isRtl(lang: TabletLang): boolean {
  return RTL_LANGS.includes(lang);
}

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
    operator_guidance:   "Operator Guidance",
    tech_support:        "Technical Support Guidance",
    tech_support_pin:    "Enter technical support PIN",
    back_to_operator:    "Back to Operator Guidance",
    back_to_checklist:   "Back to checklist",
    how_to_check:        "How to check",
    cancel:              "Cancel",
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
    operator_guidance:   "Guía para el operador",
    tech_support:        "Guía para soporte técnico",
    tech_support_pin:    "Ingrese el PIN de soporte técnico",
    back_to_operator:    "Volver a la guía del operador",
    back_to_checklist:   "Volver a la lista",
    how_to_check:        "Cómo verificar",
    cancel:              "Cancelar",
    no_active_errors:    "Esperando detalles del error…",

    language:            "Idioma",
  },
  ar: {
    enter_pin:           "أدخل رمز PIN",
    invalid_pin:         "رمز PIN غير صحيح، حاول مرة أخرى",
    invalid_token:       "جهاز غير معروف",
    invalid_token_hint:  "هذا الرابط غير مرتبط بأي ماكينة.",
    loading:             "جارٍ التحميل…",

    cell:                "الخلية",
    rank:                "الترتيب",
    machine:             "الماكينة",
    bu:                  "BU",
    uptime:              "وقت التشغيل",
    no_peers:            "لا توجد ماكينات أخرى في هذه الخلية.",

    status_running:      "قيد التشغيل",
    status_idle:         "متوقفة",
    status_offline:      "غير متصلة",
    error_header:        "خطأ",
    cause:               "السبب",
    operator_guidance:   "إرشادات المشغل",
    tech_support:        "إرشادات الدعم الفني",
    tech_support_pin:    "أدخل رمز PIN الخاص بالدعم الفني",
    back_to_operator:    "العودة إلى إرشادات المشغل",
    back_to_checklist:   "العودة إلى القائمة",
    how_to_check:        "كيفية الفحص",
    cancel:              "إلغاء",
    no_active_errors:    "في انتظار تفاصيل الخطأ…",

    language:            "اللغة",
  },
};

export function t(lang: TabletLang, key: string): string {
  return STRINGS[lang][key] ?? STRINGS.en[key] ?? key;
}
