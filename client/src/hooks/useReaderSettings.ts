import type { ChangeEvent, RefObject } from 'react';
import { isRecord } from '@lan-reader/shared';
import type { ReaderContents } from '../types/epub.js';
import type { SessionRendition } from '../types/readerSession.js';

export interface ReaderSettings { fontSize: number; fontFamilyId: string; horizontalMargin: number; verticalMargin: number; lineHeight: number; letterSpacing: number; themeId: string }
export interface FontOption { id: string; label: string; value: string }
export interface ThemeOption { id: string; label: string; swatch: string; text: string; muted: string; background: string; selection: string }
export interface LayoutSetting { id: string; label: string; value: number; valueLabel: string; min: number; max: number; step: number; onChange: (event: ChangeEvent<HTMLInputElement>) => void }
export interface ReaderSettingsOptions {
  beforeRenditionMutation?: () => void;
  containerRef: RefObject<HTMLElement | null>;
  currentCfiRef: RefObject<string | null>;
  isReaderReady: boolean;
  onSettingsReflow?: (rendition: SessionRendition | null) => void;
  renditionRef: RefObject<SessionRendition | null>;
}
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { configureEpubPageGap } from '../utils/epubPageTurnAdapter.js';

const SETTINGS_SAVE_DEBOUNCE_MS = 500;
const SETTINGS_STORAGE_KEY = 'epub-reader:reader-settings';
const DEFAULT_FONT_SIZE = 18;
const FONT_SIZE_MIN = 14;
const FONT_SIZE_MAX = 40;
const FONT_SIZE_STEP = 2;
const BASE_HORIZONTAL_MARGIN = 48;
const DEFAULT_HORIZONTAL_MARGIN = 0;
const HORIZONTAL_MARGIN_MIN = 0;
const HORIZONTAL_MARGIN_MAX = 48;
const HORIZONTAL_MARGIN_STEP = 6;
const BASE_VERTICAL_MARGIN = 60;
const DEFAULT_VERTICAL_MARGIN = 0;
const VERTICAL_MARGIN_MIN = 0;
const VERTICAL_MARGIN_MAX = 48;
const VERTICAL_MARGIN_STEP = 6;
const DEFAULT_LINE_HEIGHT = 1.6;
const LINE_HEIGHT_MIN = 1.3;
const LINE_HEIGHT_MAX = 2;
const LINE_HEIGHT_STEP = 0.1;
const DEFAULT_LETTER_SPACING = 0;
const LETTER_SPACING_MIN = 0;
const LETTER_SPACING_MAX = 0.12;
const LETTER_SPACING_STEP = 0.02;
const READER_LAYOUT_STYLE_ID = 'reader-layout-settings';
const READER_THEME_STYLE_ID = 'reader-theme-settings';
const DEFAULT_FONT_FAMILY_ID = 'system';
const DEFAULT_THEME_ID = 'light';
const FONT_FAMILY_OPTIONS: [FontOption, ...FontOption[]] = [
  {
    id: DEFAULT_FONT_FAMILY_ID,
    label: '默认',
    value: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif',
  },
  {
    id: 'pingfang',
    label: '苹方',
    value: '"PingFang SC", "PingFang TC", "PingFang HK", -apple-system, BlinkMacSystemFont, sans-serif',
  },
  {
    id: 'yahei',
    label: '微软雅黑',
    value: '"Microsoft YaHei", "Microsoft JhengHei", "PingFang SC", sans-serif',
  },
  {
    id: 'sans',
    label: '黑体',
    value: '"Heiti SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif',
  },
  {
    id: 'serif',
    label: '宋体',
    value: '"Songti SC", SimSun, "Noto Serif CJK SC", serif',
  },
  {
    id: 'kai',
    label: '楷体',
    value: '"Kaiti SC", KaiTi, serif',
  },
];
const READER_THEME_OPTIONS: [ThemeOption, ...ThemeOption[]] = [
  {
    id: DEFAULT_THEME_ID,
    label: '白色',
    swatch: '#ffffff',
    text: '#1d1d1f',
    muted: '#6e6e73',
    background: '#ffffff',
    selection: 'rgba(0, 122, 255, 0.22)',
  },
  {
    id: 'warm',
    label: '暖色',
    swatch: '#f4ecd9',
    text: '#2f271d',
    muted: '#806f5a',
    background: '#f4ecd9',
    selection: 'rgba(180, 122, 48, 0.24)',
  },
  {
    id: 'green',
    label: '护眼',
    swatch: '#dfeadb',
    text: '#1f2c22',
    muted: '#617060',
    background: '#dfeadb',
    selection: 'rgba(52, 120, 72, 0.22)',
  },
  {
    id: 'dark',
    label: '夜间',
    swatch: '#171717',
    text: '#eeeeee',
    muted: '#a6a6a6',
    background: '#171717',
    selection: 'rgba(90, 160, 255, 0.3)',
  },
];
const DEFAULT_READER_SETTINGS = {
  fontSize: DEFAULT_FONT_SIZE,
  fontFamilyId: DEFAULT_FONT_FAMILY_ID,
  horizontalMargin: DEFAULT_HORIZONTAL_MARGIN,
  verticalMargin: DEFAULT_VERTICAL_MARGIN,
  lineHeight: DEFAULT_LINE_HEIGHT,
  letterSpacing: DEFAULT_LETTER_SPACING,
  themeId: DEFAULT_THEME_ID,
};

function clampNumber(value: unknown, min: number, max: number, fallback: number) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function clampFontSize(value: unknown) {
  const clampedValue = clampNumber(value, FONT_SIZE_MIN, FONT_SIZE_MAX, DEFAULT_FONT_SIZE);
  const stepIndex = Math.round((clampedValue - FONT_SIZE_MIN) / FONT_SIZE_STEP);
  return FONT_SIZE_MIN + stepIndex * FONT_SIZE_STEP;
}

function clampHorizontalMargin(value: unknown) {
  return clampNumber(
    value,
    HORIZONTAL_MARGIN_MIN,
    HORIZONTAL_MARGIN_MAX,
    DEFAULT_HORIZONTAL_MARGIN,
  );
}

function clampVerticalMargin(value: unknown) {
  return clampNumber(
    value,
    VERTICAL_MARGIN_MIN,
    VERTICAL_MARGIN_MAX,
    DEFAULT_VERTICAL_MARGIN,
  );
}

function clampLineHeight(value: unknown) {
  return Number(
    clampNumber(value, LINE_HEIGHT_MIN, LINE_HEIGHT_MAX, DEFAULT_LINE_HEIGHT).toFixed(1),
  );
}

function clampLetterSpacing(value: unknown) {
  return Number(
    clampNumber(
      value,
      LETTER_SPACING_MIN,
      LETTER_SPACING_MAX,
      DEFAULT_LETTER_SPACING,
    ).toFixed(2),
  );
}

function sanitizeFontFamilyId(fontFamilyId: unknown) {
  return typeof fontFamilyId === 'string' && FONT_FAMILY_OPTIONS.some((option) => option.id === fontFamilyId)
    ? fontFamilyId
    : DEFAULT_FONT_FAMILY_ID;
}

function sanitizeThemeId(themeId: unknown) {
  return typeof themeId === 'string' && READER_THEME_OPTIONS.some((option) => option.id === themeId)
    ? themeId
    : DEFAULT_THEME_ID;
}

export function getEffectiveHorizontalMargin(horizontalMargin: unknown) {
  return BASE_HORIZONTAL_MARGIN + clampHorizontalMargin(horizontalMargin);
}

export function getReaderPageGap(horizontalMargin: unknown) {
  return getEffectiveHorizontalMargin(horizontalMargin) * 2;
}

function getEffectiveVerticalMargin(verticalMargin: unknown) {
  return BASE_VERTICAL_MARGIN + clampVerticalMargin(verticalMargin);
}

function getReaderFontOption(fontFamilyId: unknown) {
  return FONT_FAMILY_OPTIONS.find((option) => option.id === fontFamilyId) ||
    FONT_FAMILY_OPTIONS[0];
}

function getReaderFontFamily(fontFamilyId: unknown) {
  return getReaderFontOption(fontFamilyId).value;
}

function getReaderTheme(themeId: unknown) {
  return READER_THEME_OPTIONS.find((option) => option.id === themeId) ||
    READER_THEME_OPTIONS[0];
}

function sanitizeReaderSettings(value: unknown): ReaderSettings {
  const settings = isRecord(value) ? value : {};
  return {
    fontSize: clampFontSize(settings?.fontSize),
    fontFamilyId: sanitizeFontFamilyId(settings?.fontFamilyId),
    horizontalMargin: clampHorizontalMargin(settings?.horizontalMargin),
    verticalMargin: clampVerticalMargin(settings?.verticalMargin),
    lineHeight: clampLineHeight(settings?.lineHeight),
    letterSpacing: clampLetterSpacing(settings?.letterSpacing),
    themeId: sanitizeThemeId(settings?.themeId),
  };
}

function loadReaderSettingsFromStorage() {
  if (typeof window === 'undefined') return DEFAULT_READER_SETTINGS;

  try {
    const storedSettings = window.localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!storedSettings) return DEFAULT_READER_SETTINGS;
    return sanitizeReaderSettings(JSON.parse(storedSettings));
  } catch {
    return DEFAULT_READER_SETTINGS;
  }
}

function saveReaderSettingsToStorage(settings: ReaderSettings) {
  if (typeof window === 'undefined') return;

  try {
    window.localStorage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify(sanitizeReaderSettings(settings)),
    );
  } catch {
    // Ignore unavailable storage; reading settings will fall back to defaults.
  }
}

function getReaderLayoutCss({
  fontFamilyId,
  fontSize,
  horizontalMargin,
  verticalMargin,
  lineHeight,
  letterSpacing,
}: ReaderSettings) {
  const effectiveVerticalMargin = getEffectiveVerticalMargin(verticalMargin);
  const effectiveHorizontalMargin = getEffectiveHorizontalMargin(horizontalMargin);
  const fontFamily = getReaderFontFamily(fontFamilyId);

  return `
    html {
      margin: 0 !important;
      padding: 0 !important;
      font-family: ${fontFamily} !important;
    }

    body {
      box-sizing: border-box !important;
      font-family: ${fontFamily} !important;
      font-size: ${fontSize}px !important;
      padding-left: ${effectiveHorizontalMargin}px !important;
      padding-right: ${effectiveHorizontalMargin}px !important;
      padding-top: ${effectiveVerticalMargin}px !important;
      padding-bottom: ${effectiveVerticalMargin}px !important;
      line-height: ${lineHeight} !important;
      letter-spacing: ${letterSpacing}em !important;
      overflow-wrap: anywhere !important;
    }

    p, div, section, article, blockquote, li {
      line-height: ${lineHeight} !important;
      letter-spacing: ${letterSpacing}em !important;
      overflow-wrap: anywhere !important;
    }
  `;
}

function getReaderThemeCss(theme: ThemeOption) {
  return `
    html,
    body {
      background: ${theme.background} !important;
      color: ${theme.text} !important;
    }

    a {
      color: inherit !important;
    }

    ::selection {
      background: ${theme.selection} !important;
    }

    p, div, section, article, blockquote, li, span {
      color: ${theme.text} !important;
    }
  `;
}

function applyReaderLayoutStylesToContents(contents: ReaderContents | null, settings: ReaderSettings) {
  if (!contents) return;

  contents.addStylesheetCss?.(getReaderLayoutCss(settings), READER_LAYOUT_STYLE_ID);

  const fontSize = `${settings.fontSize}px`;
  const fontFamily = getReaderFontFamily(settings.fontFamilyId);
  const horizontalMargin = `${getEffectiveHorizontalMargin(settings.horizontalMargin)}px`;
  const verticalMargin = `${getEffectiveVerticalMargin(settings.verticalMargin)}px`;
  const lineHeight = String(settings.lineHeight);
  const letterSpacing = `${settings.letterSpacing}em`;

  contents.css?.('box-sizing', 'border-box', true);
  contents.css?.('font-size', fontSize, true);
  contents.css?.('font-family', fontFamily, true);
  contents.css?.('padding-left', horizontalMargin, true);
  contents.css?.('padding-right', horizontalMargin, true);
  contents.css?.('padding-top', verticalMargin, true);
  contents.css?.('padding-bottom', verticalMargin, true);
  contents.css?.('line-height', lineHeight, true);
  contents.css?.('letter-spacing', letterSpacing, true);
  contents.css?.('overflow-wrap', 'anywhere', true);
}

function applyReaderThemeStylesToContents(contents: ReaderContents | null, theme: ThemeOption) {
  if (!contents) return;

  contents.addStylesheetCss?.(getReaderThemeCss(theme), READER_THEME_STYLE_ID);
  contents.css?.('background', theme.background, true);
  contents.css?.('color', theme.text, true);
}

function applyReaderLayoutStylesToFrames(container: HTMLElement | null, settings: ReaderSettings) {
  if (!container) return;

  const fontSize = `${settings.fontSize}px`;
  const fontFamily = getReaderFontFamily(settings.fontFamilyId);
  const horizontalMargin = `${getEffectiveHorizontalMargin(settings.horizontalMargin)}px`;
  const verticalMargin = `${getEffectiveVerticalMargin(settings.verticalMargin)}px`;

  container.querySelectorAll('iframe').forEach((iframe) => {
    const body = iframe.contentDocument?.body;
    if (!body) return;

    body.style.setProperty('box-sizing', 'border-box', 'important');
    body.style.setProperty('font-size', fontSize, 'important');
    body.style.setProperty('font-family', fontFamily, 'important');
    body.style.setProperty('padding-left', horizontalMargin, 'important');
    body.style.setProperty('padding-right', horizontalMargin, 'important');
    body.style.setProperty('padding-top', verticalMargin, 'important');
    body.style.setProperty('padding-bottom', verticalMargin, 'important');
    body.style.setProperty('overflow-wrap', 'anywhere', 'important');
  });
}

export function applyReaderSettingsToRendition(rendition: Pick<SessionRendition, 'themes' | 'getContents'> | null, settings: ReaderSettings) {
  if (!rendition?.themes) return;
  const theme = getReaderTheme(settings.themeId);
  const horizontalMargin = `${getEffectiveHorizontalMargin(settings.horizontalMargin)}px`;
  const verticalMargin = `${getEffectiveVerticalMargin(settings.verticalMargin)}px`;
  const lineHeight = String(settings.lineHeight);
  const letterSpacing = `${settings.letterSpacing}em`;

  try {
    rendition.themes.register(settings.themeId, {
      body: {
        background: `${theme.background} !important`,
        color: `${theme.text} !important`,
      },
      a: {
        color: 'inherit !important',
      },
      '::selection': {
        background: `${theme.selection} !important`,
      },
    });
    rendition.themes.select(settings.themeId);
  } catch {
    // Content CSS below is the compatibility path for epub.js theme quirks.
  }

  rendition.getContents?.().forEach((contents) => {
    applyReaderLayoutStylesToContents(contents, settings);
    applyReaderThemeStylesToContents(contents, theme);
  });
  rendition.themes.override('box-sizing', 'border-box', true);
  rendition.themes.override('padding-left', horizontalMargin, true);
  rendition.themes.override('padding-right', horizontalMargin, true);
  rendition.themes.override('padding-top', verticalMargin, true);
  rendition.themes.override('padding-bottom', verticalMargin, true);
  rendition.themes.override('line-height', lineHeight, true);
  rendition.themes.override('letter-spacing', letterSpacing, true);
  rendition.themes.override('overflow-wrap', 'anywhere', true);
  rendition.themes.override('background', theme.background, true);
  rendition.themes.override('color', theme.text, true);
  rendition.themes.fontSize(`${settings.fontSize}px`);
  rendition.themes.font(getReaderFontFamily(settings.fontFamilyId));
}

function applyReaderHorizontalMarginStylesToRendition(rendition: SessionRendition | null, horizontalMargin: number) {
  if (!rendition?.themes) return;

  const effectiveHorizontalMargin = `${getEffectiveHorizontalMargin(horizontalMargin)}px`;

  rendition.getContents?.().forEach((contents) => {
    contents.css?.('box-sizing', 'border-box', true);
    contents.css?.('padding-left', effectiveHorizontalMargin, true);
    contents.css?.('padding-right', effectiveHorizontalMargin, true);
  });
  rendition.themes.override('box-sizing', 'border-box', true);
  rendition.themes.override('padding-left', effectiveHorizontalMargin, true);
  rendition.themes.override('padding-right', effectiveHorizontalMargin, true);
}

async function applyReaderHorizontalMarginToRendition(rendition: SessionRendition | null, horizontalMargin: number, cfi: string | null, isCurrent: () => boolean) {
  if (!rendition) return;

  configureEpubPageGap(rendition, getReaderPageGap(horizontalMargin));
  rendition.resize?.();
  applyReaderHorizontalMarginStylesToRendition(rendition, horizontalMargin);

  if (cfi) {
    await rendition.display(cfi);
    if (!isCurrent()) return;
    applyReaderHorizontalMarginStylesToRendition(rendition, horizontalMargin);
  }
}

export function useReaderSettings({
  beforeRenditionMutation,
  containerRef,
  currentCfiRef,
  isReaderReady,
  onSettingsReflow,
  renditionRef,
}: ReaderSettingsOptions) {
  const initialSettings = useMemo(() => loadReaderSettingsFromStorage(), []);
  const settingsSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingReaderSettingsRef = useRef<ReaderSettings | null>(null);
  const readerSettingsRef = useRef(initialSettings);
  const settingsActiveRef = useRef(true);
  const layoutTimersRef = useRef(new Set<ReturnType<typeof setTimeout>>());
  const layoutFramesRef = useRef(new Set<number>());
  const [fontSize, setFontSize] = useState(initialSettings.fontSize);
  const [fontFamilyId, setFontFamilyId] = useState(initialSettings.fontFamilyId);
  const [horizontalMargin, setHorizontalMargin] = useState(initialSettings.horizontalMargin);
  const [verticalMargin, setVerticalMargin] = useState(initialSettings.verticalMargin);
  const [lineHeight, setLineHeight] = useState(initialSettings.lineHeight);
  const [letterSpacing, setLetterSpacing] = useState(initialSettings.letterSpacing);
  const [readerThemeId, setReaderThemeId] = useState(initialSettings.themeId);
  const [hasLoadedReaderSettings, setHasLoadedReaderSettings] = useState(false);

  const readerSettings = useMemo(() => ({
    fontSize,
    fontFamilyId,
    horizontalMargin,
    verticalMargin,
    lineHeight,
    letterSpacing,
    themeId: readerThemeId,
  }), [
    fontSize,
    fontFamilyId,
    horizontalMargin,
    verticalMargin,
    lineHeight,
    letterSpacing,
    readerThemeId,
  ]);

  useEffect(() => {
    readerSettingsRef.current = readerSettings;
  }, [readerSettings]);

  const updateReaderSettingsState = useCallback((settings: ReaderSettings | null) => {
    const nextSettings = sanitizeReaderSettings(settings);
    readerSettingsRef.current = nextSettings;
    setFontSize(nextSettings.fontSize);
    setFontFamilyId(nextSettings.fontFamilyId);
    setHorizontalMargin(nextSettings.horizontalMargin);
    setVerticalMargin(nextSettings.verticalMargin);
    setLineHeight(nextSettings.lineHeight);
    setLetterSpacing(nextSettings.letterSpacing);
    setReaderThemeId(nextSettings.themeId);
    return nextSettings;
  }, []);

  const loadReaderSettings = useCallback(async () => {
    return updateReaderSettingsState(loadReaderSettingsFromStorage());
  }, [updateReaderSettingsState]);

  const resetReaderSettingsLoad = useCallback(() => {
    setHasLoadedReaderSettings(false);
  }, []);

  const markReaderSettingsLoaded = useCallback(() => {
    setHasLoadedReaderSettings(true);
  }, []);

  const flushReaderSettingsSave = useCallback((settings: ReaderSettings | null) => {
    if (!settings) return;
    saveReaderSettingsToStorage(settings);
  }, []);

  const flushPendingReaderSettings = useCallback(() => {
    if (settingsSaveTimerRef.current) clearTimeout(settingsSaveTimerRef.current);
    flushReaderSettingsSave(pendingReaderSettingsRef.current);
    pendingReaderSettingsRef.current = null;
  }, [flushReaderSettingsSave]);

  const scheduleReaderSettingsSave = useCallback((settings: ReaderSettings | null) => {
    pendingReaderSettingsRef.current = settings;
    if (settingsSaveTimerRef.current) clearTimeout(settingsSaveTimerRef.current);
    settingsSaveTimerRef.current = setTimeout(() => {
      flushReaderSettingsSave(pendingReaderSettingsRef.current);
      pendingReaderSettingsRef.current = null;
    }, SETTINGS_SAVE_DEBOUNCE_MS);
  }, [flushReaderSettingsSave]);

  useEffect(() => {
    settingsActiveRef.current = true;
    const timers = layoutTimersRef.current;
    const frames = layoutFramesRef.current;
    return () => {
      settingsActiveRef.current = false;
      flushPendingReaderSettings();
      timers.forEach(clearTimeout);
      frames.forEach(cancelAnimationFrame);
      timers.clear();
      frames.clear();
    };
  }, [flushPendingReaderSettings]);

  const syncReaderFrameLayout = useCallback(() => {
    const container = containerRef.current;
    const applyLatestLayout = () => {
      if (containerRef.current !== container) return;
      applyReaderLayoutStylesToFrames(container, readerSettingsRef.current);
    };
    const scheduleTimer = (delay: number) => {
      const timer = setTimeout(() => {
        layoutTimersRef.current.delete(timer);
        applyLatestLayout();
      }, delay);
      layoutTimersRef.current.add(timer);
    };

    applyLatestLayout();

    if (typeof requestAnimationFrame === 'function') {
      const frame = requestAnimationFrame(() => {
        layoutFramesRef.current.delete(frame);
        applyLatestLayout();
      });
      layoutFramesRef.current.add(frame);
    } else {
      scheduleTimer(0);
    }

    scheduleTimer(120);
  }, [containerRef]);

  const applyReaderSettings = useCallback((rendition: SessionRendition | null, settings = readerSettingsRef.current) => {
    applyReaderSettingsToRendition(rendition, settings);
    syncReaderFrameLayout();
  }, [syncReaderFrameLayout]);

  const applyReaderSettingsToContents = useCallback((contents: ReaderContents, settings = readerSettingsRef.current) => {
    const theme = getReaderTheme(settings.themeId);
    applyReaderLayoutStylesToContents(contents, settings);
    applyReaderThemeStylesToContents(contents, theme);
  }, []);

  const applyReaderHorizontalMargin = useCallback((
    rendition: SessionRendition | null,
    horizontalMarginValue = readerSettingsRef.current.horizontalMargin,
    cfi = currentCfiRef.current,
  ) => (
    applyReaderHorizontalMarginToRendition(rendition, horizontalMarginValue, cfi, () => settingsActiveRef.current && renditionRef.current === rendition)
      .then((result) => {
        if (settingsActiveRef.current && renditionRef.current === rendition) syncReaderFrameLayout();
        return result;
      })
  ), [currentCfiRef, renditionRef, syncReaderFrameLayout]);

  useEffect(() => {
    if (!isReaderReady) return undefined;
    const rendition = renditionRef.current;
    beforeRenditionMutation?.();
    applyReaderSettings(rendition, readerSettingsRef.current);

    const timer = setTimeout(() => {
      onSettingsReflow?.(rendition);
    }, 80);

    return () => clearTimeout(timer);
  }, [
    applyReaderSettings,
    beforeRenditionMutation,
    isReaderReady,
    onSettingsReflow,
    readerSettings,
    renditionRef,
  ]);

  useEffect(() => {
    if (!isReaderReady) return;
    const rendition = renditionRef.current;
    beforeRenditionMutation?.();
    let cancelled = false;
    applyReaderHorizontalMargin(
      rendition,
      horizontalMargin,
      currentCfiRef.current,
    )
      .then(() => {
        if (!cancelled && renditionRef.current === rendition) onSettingsReflow?.(rendition);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [
    applyReaderHorizontalMargin,
    beforeRenditionMutation,
    currentCfiRef,
    horizontalMargin,
    isReaderReady,
    onSettingsReflow,
    renditionRef,
  ]);

  useEffect(() => {
    if (!hasLoadedReaderSettings) return;
    scheduleReaderSettingsSave(readerSettingsRef.current);
  }, [hasLoadedReaderSettings, readerSettings, scheduleReaderSettingsSave]);

  const decreaseFontSize = useCallback(() => {
    setFontSize((size) => clampFontSize(size - FONT_SIZE_STEP));
  }, []);

  const increaseFontSize = useCallback(() => {
    setFontSize((size) => clampFontSize(size + FONT_SIZE_STEP));
  }, []);

  const handleFontSizeChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setFontSize(clampFontSize(event.target.value));
  }, []);

  const handleFontFamilyChange = useCallback((nextFontFamilyId: string) => {
    setFontFamilyId(sanitizeFontFamilyId(nextFontFamilyId));
  }, []);

  const handleHorizontalMarginChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setHorizontalMargin(clampHorizontalMargin(event.target.value));
  }, []);

  const handleVerticalMarginChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setVerticalMargin(clampVerticalMargin(event.target.value));
  }, []);

  const handleLineHeightChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setLineHeight(clampLineHeight(event.target.value));
  }, []);

  const handleLetterSpacingChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setLetterSpacing(clampLetterSpacing(event.target.value));
  }, []);

  const handleThemeChange = useCallback((nextThemeId: string) => {
    setReaderThemeId(sanitizeThemeId(nextThemeId));
  }, []);

  const readerTheme = useMemo(() => getReaderTheme(readerThemeId), [readerThemeId]);
  const readerFont = useMemo(() => getReaderFontOption(fontFamilyId), [fontFamilyId]);
  const layoutSettings = useMemo(() => [
    {
      id: 'reader-horizontal-margin-title',
      label: '左右边距',
      value: horizontalMargin,
      valueLabel: `额外 ${horizontalMargin}px / 实际 ${getEffectiveHorizontalMargin(horizontalMargin)}px`,
      min: HORIZONTAL_MARGIN_MIN,
      max: HORIZONTAL_MARGIN_MAX,
      step: HORIZONTAL_MARGIN_STEP,
      onChange: handleHorizontalMarginChange,
    },
    {
      id: 'reader-vertical-margin-title',
      label: '上下边距',
      value: verticalMargin,
      valueLabel: `额外 ${verticalMargin}px / 实际 ${getEffectiveVerticalMargin(verticalMargin)}px`,
      min: VERTICAL_MARGIN_MIN,
      max: VERTICAL_MARGIN_MAX,
      step: VERTICAL_MARGIN_STEP,
      onChange: handleVerticalMarginChange,
    },
    {
      id: 'reader-line-height-title',
      label: '行距',
      value: lineHeight,
      valueLabel: lineHeight.toFixed(1),
      min: LINE_HEIGHT_MIN,
      max: LINE_HEIGHT_MAX,
      step: LINE_HEIGHT_STEP,
      onChange: handleLineHeightChange,
    },
    {
      id: 'reader-letter-spacing-title',
      label: '字距',
      value: letterSpacing,
      valueLabel: letterSpacing === 0 ? '默认' : `${letterSpacing.toFixed(2)}em`,
      min: LETTER_SPACING_MIN,
      max: LETTER_SPACING_MAX,
      step: LETTER_SPACING_STEP,
      onChange: handleLetterSpacingChange,
    },
  ], [
    handleHorizontalMarginChange,
    handleLetterSpacingChange,
    handleLineHeightChange,
    handleVerticalMarginChange,
    horizontalMargin,
    letterSpacing,
    lineHeight,
    verticalMargin,
  ]);

  return {
    applyReaderHorizontalMargin,
    applyReaderSettings,
    applyReaderSettingsToContents,
    decreaseFontSize,
    flushPendingReaderSettings,
    fontFamilyId,
    fontFamilyOptions: FONT_FAMILY_OPTIONS,
    fontSize,
    fontSizeMax: FONT_SIZE_MAX,
    fontSizeMin: FONT_SIZE_MIN,
    fontSizeStep: FONT_SIZE_STEP,
    handleFontFamilyChange,
    handleFontSizeChange,
    handleThemeChange,
    increaseFontSize,
    layoutSettings,
    loadReaderSettings,
    markReaderSettingsLoaded,
    readerFont,
    readerSettingsRef,
    readerTheme,
    readerThemeId,
    resetReaderSettingsLoad,
    themeOptions: READER_THEME_OPTIONS,
  };
}
