import { type PointerEvent as ReactPointerEvent, useCallback, useEffect, useRef, useState } from "react";
import { Toaster, toast } from "sonner";
import { DEFAULT_APP_TITLE, loadTtyConfig, type TtyConfig } from "./config";
import type { SoftKeyModifiers } from "./softKeyboard";
import {
  applyShiftToPrintable,
  buildSoftKeySequence,
  COMBO_KEY_ROW,
  DEFAULT_SOFT_KEY_MODIFIERS,
  DESKTOP_PC_ARROW_ROWS,
  DESKTOP_PC_FUNCTION_ROW,
  DESKTOP_PC_MAIN_ROWS,
  DESKTOP_PC_NAV_ROWS,
  FUNCTION_KEY_ROW,
  PRIMARY_SCREEN_ROWS,
  SECONDARY_SCREEN_ROWS,
  type SoftKeyboardScreen,
  type SoftKeyDefinition,
  type SoftModifierName,
} from "./softKeyboard";
import { SESSION_STORAGE_KEY, useTerminal } from "./useTerminal";

function softKeyLabel(key: SoftKeyDefinition, shiftActive: boolean): string {
  if (key.kind === "printable") {
    if (shiftActive) {
      return applyShiftToPrintable(key.value, true);
    }
    if (/^[a-z]$/.test(key.value)) {
      return key.value;
    }
  }
  return key.label;
}

function softKeyShiftHint(key: SoftKeyDefinition, shiftActive: boolean): string | null {
  if (shiftActive) return null;
  if (key.kind !== "printable") return null;
  if (/^[a-z]$/.test(key.value)) return null;
  const shifted = applyShiftToPrintable(key.value, true);
  if (shifted === key.value) return null;
  return shifted;
}

const AES_GCM_IV_SIZE = 12;

interface EncryptedClipboardPayload {
  encryptedContent: Uint8Array;
  iv: Uint8Array;
}

interface DragRefBase {
  pointerId: number;
  offsetX: number;
  offsetY: number;
}

interface ArrowOverlayDragRef extends DragRefBase {
  startX: number;
  startY: number;
}

interface FloatingPressedOverlay {
  left: number;
  top: number;
  width: number;
  height: number;
  text: string;
}

const ROW_KEYS = ["num", "alpha1", "alpha2", "alpha3", "bottom"] as const;
const DESKTOP_WIDTH_BREAKPOINT = 1024;
const OVERLAY_DRAG_ACTIVATION_PX = 6;
const DEFAULT_MIN_COLUMNS = 80;
const MIN_COLUMNS_OPTIONS = [80, 100, 120, 140] as const;

const SECONDARY_ROW2_ARROW_LABELS = new Set([",", "▲", "Ins"]);
const SECONDARY_ROW3_ARROW_LABELS = new Set(["◀", "▼", "▶"]);

const FRAME_BKSP: SoftKeyDefinition = {
  id: "special-backspace",
  label: "Bksp",
  kind: "special",
  special: "backspace",
  group: "main",
};

const FRAME_ENTER: SoftKeyDefinition = {
  id: "special-enter",
  label: "Enter",
  kind: "special",
  special: "enter",
  group: "main",
};

const FRAME_SPACE: SoftKeyDefinition = {
  id: "printable-%20",
  label: "Space",
  kind: "printable",
  value: " ",
  group: "main",
};

const OVERLAY_ARROW_UP: SoftKeyDefinition = {
  id: "overlay-arrow-up",
  label: "\u25B2\uFE0E",
  kind: "special",
  special: "arrowUp",
  group: "main",
};

const OVERLAY_ARROW_LEFT: SoftKeyDefinition = {
  id: "overlay-arrow-left",
  label: "\u25C0\uFE0E",
  kind: "special",
  special: "arrowLeft",
  group: "main",
};

const OVERLAY_ARROW_DOWN: SoftKeyDefinition = {
  id: "overlay-arrow-down",
  label: "\u25BC\uFE0E",
  kind: "special",
  special: "arrowDown",
  group: "main",
};

const OVERLAY_ARROW_RIGHT: SoftKeyDefinition = {
  id: "overlay-arrow-right",
  label: "\u25B6\uFE0E",
  kind: "special",
  special: "arrowRight",
  group: "main",
};

function ExtraKeyButton({
  softKey,
  className,
  children,
  startKeyRepeat,
  stopKeyRepeat,
  onVisualPressStart,
  onVisualPressEnd,
}: {
  softKey: SoftKeyDefinition;
  className?: string;
  children: React.ReactNode;
  startKeyRepeat: (key: SoftKeyDefinition) => void;
  stopKeyRepeat: () => void;
  onVisualPressStart?: (key: SoftKeyDefinition, buttonEl: HTMLButtonElement, pointerId: number) => void;
  onVisualPressEnd?: () => void;
}) {
  return (
    <button
      type="button"
      className={`toolbar-button extra-key-button ${className ?? ""}`}
      onPointerDown={(e) => {
        e.preventDefault();
        onVisualPressStart?.(softKey, e.currentTarget, e.pointerId);
        startKeyRepeat(softKey);
      }}
      onPointerUp={() => {
        stopKeyRepeat();
        onVisualPressEnd?.();
      }}
      onPointerLeave={() => {
        stopKeyRepeat();
        onVisualPressEnd?.();
      }}
      onPointerCancel={() => {
        stopKeyRepeat();
        onVisualPressEnd?.();
      }}
    >
      {children}
    </button>
  );
}

function ArrowKeyButton({
  softKey,
  ariaLabel,
  startKeyRepeat,
  stopKeyRepeat,
}: {
  softKey: SoftKeyDefinition;
  ariaLabel: string;
  startKeyRepeat: (key: SoftKeyDefinition) => void;
  stopKeyRepeat: () => void;
}) {
  return (
    <button
      type="button"
      className="toolbar-button arrow-overlay-button"
      aria-label={ariaLabel}
      onPointerDown={(event) => {
        event.preventDefault();
        startKeyRepeat(softKey);
      }}
      onPointerUp={stopKeyRepeat}
      onPointerLeave={stopKeyRepeat}
      onPointerCancel={stopKeyRepeat}
    >
      {softKey.label}
    </button>
  );
}

function MobileSoftKeyboardGrid({
  keyboardScreen,
  softKeyModifiers,
  toggleSoftModifier,
  toggleKeyboardScreen,
  startKeyRepeat,
  stopKeyRepeat,
  onVisualPressStart,
  onVisualPressEnd,
}: {
  keyboardScreen: SoftKeyboardScreen;
  softKeyModifiers: SoftKeyModifiers;
  toggleSoftModifier: (modifier: SoftModifierName) => void;
  toggleKeyboardScreen: () => void;
  startKeyRepeat: (key: SoftKeyDefinition) => void;
  stopKeyRepeat: () => void;
  onVisualPressStart?: (key: SoftKeyDefinition, buttonEl: HTMLButtonElement, pointerId: number) => void;
  onVisualPressEnd?: () => void;
}) {
  const screenRows = keyboardScreen === "primary" ? PRIMARY_SCREEN_ROWS : SECONDARY_SCREEN_ROWS;

  return (
    <div className="extra-keys-grid" role="group" aria-label="Terminal keys">
      {keyboardScreen === "primary" && (
        <div className="extra-keys-fkey-row extra-keys-combo-row">
          {COMBO_KEY_ROW.map((combo) => (
            <ExtraKeyButton
              key={combo.id}
              softKey={combo}
              className="extra-key-combo"
              startKeyRepeat={startKeyRepeat}
              stopKeyRepeat={stopKeyRepeat}
              onVisualPressStart={onVisualPressStart}
              onVisualPressEnd={onVisualPressEnd}
            >
              {combo.label}
            </ExtraKeyButton>
          ))}
        </div>
      )}
      {keyboardScreen === "secondary" && (
        <div className="extra-keys-fkey-row">
          {FUNCTION_KEY_ROW.map((fkey) => (
            <ExtraKeyButton
              key={fkey.id}
              softKey={fkey}
              className="extra-key-fkey"
              startKeyRepeat={startKeyRepeat}
              stopKeyRepeat={stopKeyRepeat}
              onVisualPressStart={onVisualPressStart}
              onVisualPressEnd={onVisualPressEnd}
            >
              {fkey.label}
            </ExtraKeyButton>
          ))}
        </div>
      )}
      {screenRows.map((row, rowIndex) => (
        <div
          key={ROW_KEYS[rowIndex]}
          className={`extra-keys-row${rowIndex === 3 && keyboardScreen === "primary" ? " extra-keys-zrow" : ""}`}
        >
          {rowIndex === 3 && (
            <button
              type="button"
              className={`toolbar-button extra-key-button extra-key-wide-xl ${softKeyModifiers.shift ? "toolbar-button-active" : ""}`}
              onClick={() => toggleSoftModifier("shift")}
              aria-pressed={softKeyModifiers.shift}
            >
              ⇧
            </button>
          )}
          {rowIndex === 4 && (
            <>
              <button
                type="button"
                className="toolbar-button extra-key-button extra-key-meta extra-key-wide-md"
                onClick={toggleKeyboardScreen}
                aria-label={keyboardScreen === "primary" ? "Switch to symbols keyboard" : "Switch to alphabet keyboard"}
              >
                {keyboardScreen === "primary" ? "sym" : "abc"}
              </button>
              <button
                type="button"
                className={`toolbar-button extra-key-button extra-key-wide-md ${softKeyModifiers.ctrl ? "toolbar-button-active" : ""}`}
                onClick={() => toggleSoftModifier("ctrl")}
                aria-pressed={softKeyModifiers.ctrl}
              >
                Ctrl
              </button>
              <button
                type="button"
                className={`toolbar-button extra-key-button extra-key-wide-md ${softKeyModifiers.alt ? "toolbar-button-active" : ""}`}
                onClick={() => toggleSoftModifier("alt")}
                aria-pressed={softKeyModifiers.alt}
              >
                Alt
              </button>
              <ExtraKeyButton
                softKey={FRAME_SPACE}
                className="extra-key-button-space"
                startKeyRepeat={startKeyRepeat}
                stopKeyRepeat={stopKeyRepeat}
                onVisualPressStart={onVisualPressStart}
                onVisualPressEnd={onVisualPressEnd}
              >
                Space
              </ExtraKeyButton>
            </>
          )}
          {(() => {
            const dataKeys = row.map((key) => {
              const label = softKeyLabel(key, softKeyModifiers.shift);
              const hint = softKeyShiftHint(key, softKeyModifiers.shift);
              const isSecondaryArrow =
                keyboardScreen === "secondary" &&
                ((rowIndex === 2 && SECONDARY_ROW2_ARROW_LABELS.has(key.label)) ||
                  (rowIndex === 3 && SECONDARY_ROW3_ARROW_LABELS.has(key.label)));
              const classes = [
                label.length === 1 ? "extra-key-single-char" : "",
                isSecondaryArrow ? "extra-key-arrow" : "",
              ]
                .filter(Boolean)
                .join(" ");
              return (
                <ExtraKeyButton
                  key={key.id}
                  softKey={key}
                  className={classes}
                  startKeyRepeat={startKeyRepeat}
                  stopKeyRepeat={stopKeyRepeat}
                  onVisualPressStart={onVisualPressStart}
                  onVisualPressEnd={onVisualPressEnd}
                >
                  {label}
                  {hint && <span className="extra-key-shift-hint">{hint}</span>}
                </ExtraKeyButton>
              );
            });
            if (rowIndex === 4) {
              return <div className="extra-key-data-group">{dataKeys}</div>;
            }
            if (rowIndex === 2 && keyboardScreen === "primary") {
              return (
                <>
                  <div className="extra-key-spacer extra-key-half-spacer" />
                  {dataKeys}
                  <div className="extra-key-spacer extra-key-half-spacer" />
                </>
              );
            }
            if (rowIndex === 3 && keyboardScreen === "primary") {
              return <div className="extra-key-data-group extra-key-zrow-group">{dataKeys}</div>;
            }
            return dataKeys;
          })()}
          {rowIndex === 3 && keyboardScreen === "primary" && (
            <ExtraKeyButton
              softKey={FRAME_BKSP}
              className="extra-key-wide-lg"
              startKeyRepeat={startKeyRepeat}
              stopKeyRepeat={stopKeyRepeat}
              onVisualPressStart={onVisualPressStart}
              onVisualPressEnd={onVisualPressEnd}
            >
              ⌫
            </ExtraKeyButton>
          )}
          {rowIndex === 4 && (
            <ExtraKeyButton
              softKey={FRAME_ENTER}
              className="extra-key-wide-xl"
              startKeyRepeat={startKeyRepeat}
              stopKeyRepeat={stopKeyRepeat}
              onVisualPressStart={onVisualPressStart}
              onVisualPressEnd={onVisualPressEnd}
            >
              Enter
            </ExtraKeyButton>
          )}
        </div>
      ))}
    </div>
  );
}

function DesktopPcKeyboardGrid({
  softKeyModifiers,
  toggleSoftModifier,
  startKeyRepeat,
  stopKeyRepeat,
  onVisualPressStart,
  onVisualPressEnd,
}: {
  softKeyModifiers: SoftKeyModifiers;
  toggleSoftModifier: (modifier: SoftModifierName) => void;
  startKeyRepeat: (key: SoftKeyDefinition) => void;
  stopKeyRepeat: () => void;
  onVisualPressStart?: (key: SoftKeyDefinition, buttonEl: HTMLButtonElement, pointerId: number) => void;
  onVisualPressEnd?: () => void;
}) {
  const renderSoftKey = (key: SoftKeyDefinition, className?: string) => {
    const label = softKeyLabel(key, softKeyModifiers.shift);
    const hint = softKeyShiftHint(key, softKeyModifiers.shift);
    const classes = [label.length === 1 ? "extra-key-single-char" : "", className ?? ""].filter(Boolean).join(" ");
    return (
      <ExtraKeyButton
        key={key.id}
        softKey={key}
        className={classes}
        startKeyRepeat={startKeyRepeat}
        stopKeyRepeat={stopKeyRepeat}
        onVisualPressStart={onVisualPressStart}
        onVisualPressEnd={onVisualPressEnd}
      >
        {label}
        {hint && <span className="extra-key-shift-hint">{hint}</span>}
      </ExtraKeyButton>
    );
  };

  const numberRow = DESKTOP_PC_MAIN_ROWS[0] ?? [];
  const qwertyRow = DESKTOP_PC_MAIN_ROWS[1] ?? [];
  const homeRow = DESKTOP_PC_MAIN_ROWS[2] ?? [];
  const zxcvRow = DESKTOP_PC_MAIN_ROWS[3] ?? [];
  const spaceRow = DESKTOP_PC_MAIN_ROWS[4] ?? [];

  return (
    <div className="desktop-pc-layout" role="group" aria-label="Terminal keys">
      <div className="desktop-pc-main">
        <div className="desktop-pc-row desktop-pc-row-function">
          {DESKTOP_PC_FUNCTION_ROW.map((key) =>
            renderSoftKey(
              key,
              key.kind === "function" ? "extra-key-fkey desktop-key-function" : "desktop-key-esc desktop-key-function",
            ),
          )}
        </div>

        <div className="desktop-pc-row">
          {numberRow.map((key, index) =>
            renderSoftKey(key, index === numberRow.length - 1 ? "desktop-key-wide-bksp" : undefined),
          )}
        </div>

        <div className="desktop-pc-row">
          {qwertyRow.map((key, index) =>
            renderSoftKey(
              key,
              index === 0
                ? "desktop-key-wide-tab"
                : index === qwertyRow.length - 1
                  ? "desktop-key-wide-slash"
                  : undefined,
            ),
          )}
        </div>

        <div className="desktop-pc-row">
          <div className="desktop-pc-left-spacer desktop-pc-home-left-spacer" aria-hidden />
          {homeRow.map((key, index) =>
            renderSoftKey(key, index === homeRow.length - 1 ? "desktop-key-wide-enter" : undefined),
          )}
        </div>

        <div className="desktop-pc-row">
          <button
            type="button"
            className={`toolbar-button extra-key-button desktop-key-wide-shift ${softKeyModifiers.shift ? "toolbar-button-active" : ""}`}
            onClick={() => toggleSoftModifier("shift")}
            aria-pressed={softKeyModifiers.shift}
          >
            Shift
          </button>
          {zxcvRow.map((key) => renderSoftKey(key))}
          <button
            type="button"
            className={`toolbar-button extra-key-button desktop-key-wide-shift ${softKeyModifiers.shift ? "toolbar-button-active" : ""}`}
            onClick={() => toggleSoftModifier("shift")}
            aria-pressed={softKeyModifiers.shift}
          >
            Shift
          </button>
        </div>

        <div className="desktop-pc-row">
          <button
            type="button"
            className={`toolbar-button extra-key-button desktop-key-wide-modifier ${softKeyModifiers.ctrl ? "toolbar-button-active" : ""}`}
            onClick={() => toggleSoftModifier("ctrl")}
            aria-pressed={softKeyModifiers.ctrl}
          >
            Ctrl
          </button>
          <button
            type="button"
            className={`toolbar-button extra-key-button desktop-key-wide-modifier ${softKeyModifiers.alt ? "toolbar-button-active" : ""}`}
            onClick={() => toggleSoftModifier("alt")}
            aria-pressed={softKeyModifiers.alt}
          >
            Alt
          </button>
          {spaceRow[0] ? renderSoftKey(spaceRow[0], "desktop-key-space") : null}
          <button
            type="button"
            className={`toolbar-button extra-key-button desktop-key-wide-modifier ${softKeyModifiers.alt ? "toolbar-button-active" : ""}`}
            onClick={() => toggleSoftModifier("alt")}
            aria-pressed={softKeyModifiers.alt}
          >
            Alt
          </button>
          <button
            type="button"
            className={`toolbar-button extra-key-button desktop-key-wide-modifier ${softKeyModifiers.ctrl ? "toolbar-button-active" : ""}`}
            onClick={() => toggleSoftModifier("ctrl")}
            aria-pressed={softKeyModifiers.ctrl}
          >
            Ctrl
          </button>
        </div>
      </div>

      <aside className="desktop-pc-side" aria-label="Navigation and arrow keys">
        <div className="desktop-pc-side-panel">
          <div className="desktop-pc-nav">
            {DESKTOP_PC_NAV_ROWS.map((row) => (
              <div key={`desktop-nav-${row.map((key) => key.id).join("-")}`} className="desktop-pc-side-row">
                {row.map((key) => renderSoftKey(key, "desktop-key-side"))}
              </div>
            ))}
          </div>

          <div className="desktop-pc-arrows">
            <div className="desktop-pc-side-row desktop-pc-arrow-row-up">
              <div className="desktop-pc-spacer" />
              {(DESKTOP_PC_ARROW_ROWS[0] ?? []).map((key) => renderSoftKey(key, "desktop-key-side desktop-key-arrow"))}
              <div className="desktop-pc-spacer" />
            </div>
            <div className="desktop-pc-side-row desktop-pc-arrow-row-main">
              {(DESKTOP_PC_ARROW_ROWS[1] ?? []).map((key) => renderSoftKey(key, "desktop-key-side desktop-key-arrow"))}
            </div>
          </div>
        </div>
      </aside>
    </div>
  );
}

function formatShellCommand(args: string[]): string {
  if (args.length === 0) return "shell";
  return args.map((a) => (/[^a-zA-Z0-9_\-./=:@]/.test(a) ? `'${a.replace(/'/g, "'\\''")}'` : a)).join(" ");
}

export function App() {
  const [config, setConfig] = useState<TtyConfig | null>(null);
  const [remoteTitle, setRemoteTitle] = useState<string | null>(null);
  const [copyModePickerOpen, setCopyModePickerOpen] = useState(false);
  const [selectableText, setSelectableText] = useState<string | null>(null);
  const [pasteHelperText, setPasteHelperText] = useState<string | null>(null);
  const [pendingClipboardPayload, setPendingClipboardPayload] = useState<EncryptedClipboardPayload | null>(null);
  const [clipboardSeq, setClipboardSeq] = useState(0);
  const [processesText, setProcessesText] = useState<string | null>(null);
  const [softKeysOpen, setSoftKeysOpen] = useState(false);
  const [isDesktopWide, setIsDesktopWide] = useState(() =>
    typeof window !== "undefined" ? window.innerWidth >= DESKTOP_WIDTH_BREAKPOINT : false,
  );
  const [keyboardScreen, setKeyboardScreen] = useState<SoftKeyboardScreen>("primary");
  const [softKeyModifiers, setSoftKeyModifiers] = useState(() => ({
    ...DEFAULT_SOFT_KEY_MODIFIERS,
  }));
  const [overflowMenuOpen, setOverflowMenuOpen] = useState(false);
  const [fontSize, setFontSize] = useState<number | undefined>(undefined);
  const [fontSizeMenuOpen, setFontSizeMenuOpen] = useState(false);
  const [minColumns, setMinColumns] = useState<number | undefined>(undefined);
  const [minColumnsMenuOpen, setMinColumnsMenuOpen] = useState(false);
  const [infoDialogOpen, setInfoDialogOpen] = useState(false);
  const [arrowOverlayEnabled, setArrowOverlayEnabled] = useState(true);
  const [awaitingStart, setAwaitingStart] = useState(true);
  const effectiveMinColumns = minColumns ?? DEFAULT_MIN_COLUMNS;
  const startOverlayRef = useCallback((el: HTMLDivElement | null) => {
    if (el) el.focus();
  }, []);
  const overflowMenuRef = useRef<HTMLDivElement>(null);
  const copyModeMenuRef = useRef<HTMLDivElement>(null);
  const selectableTextRef = useRef<HTMLTextAreaElement | null>(null);
  const pasteHelperRef = useRef<HTMLTextAreaElement | null>(null);
  const pasteHelperFocusedRef = useRef(false);

  const clipboardCryptoKeyRef = useRef<CryptoKey | null>(null);

  const getClipboardCryptoKey = useCallback(async (): Promise<CryptoKey> => {
    const existing = clipboardCryptoKeyRef.current;
    if (existing) return existing;
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    clipboardCryptoKeyRef.current = key;
    return key;
  }, []);

  const encryptClipboardText = useCallback(
    async (text: string): Promise<EncryptedClipboardPayload> => {
      const key = await getClipboardCryptoKey();
      const iv = crypto.getRandomValues(new Uint8Array(AES_GCM_IV_SIZE));
      const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(text));
      return { encryptedContent: new Uint8Array(encrypted), iv };
    },
    [getClipboardCryptoKey],
  );

  const decryptClipboardPayload = useCallback(
    async (payload: EncryptedClipboardPayload): Promise<string> => {
      const key = await getClipboardCryptoKey();
      const buf = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: payload.iv as BufferSource },
        key,
        payload.encryptedContent as BufferSource,
      );
      return new TextDecoder().decode(new Uint8Array(buf));
    },
    [getClipboardCryptoKey],
  );

  useEffect(() => {
    if (!overflowMenuOpen) {
      return;
    }
    const close = (e: MouseEvent | TouchEvent) => {
      if (overflowMenuRef.current && !overflowMenuRef.current.contains(e.target as Node)) {
        setOverflowMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("touchstart", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("touchstart", close);
    };
  }, [overflowMenuOpen]);

  useEffect(() => {
    if (!copyModePickerOpen) {
      return;
    }

    const close = (e: MouseEvent | TouchEvent) => {
      if (copyModeMenuRef.current && !copyModeMenuRef.current.contains(e.target as Node)) {
        setCopyModePickerOpen(false);
      }
    };
    const closeOnEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setCopyModePickerOpen(false);
      }
    };

    document.addEventListener("mousedown", close);
    document.addEventListener("touchstart", close);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("touchstart", close);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [copyModePickerOpen]);

  const overflowAction = useCallback((action: () => void) => {
    setOverflowMenuOpen(false);
    action();
  }, []);

  const openFontSizeMenu = useCallback(() => {
    setMinColumnsMenuOpen(false);
    setFontSizeMenuOpen(true);
  }, []);

  const closeFontSizeMenu = useCallback(() => {
    setFontSizeMenuOpen(false);
  }, []);

  const openMinColumnsMenu = useCallback(() => {
    setFontSizeMenuOpen(false);
    setMinColumnsMenuOpen(true);
  }, []);

  const closeMinColumnsMenu = useCallback(() => {
    setMinColumnsMenuOpen(false);
  }, []);

  useEffect(() => {
    let cancelled = false;
    loadTtyConfig()
      .then((cfg) => {
        if (!cancelled) {
          setConfig(cfg);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          console.error("Failed to load configuration:", error);
          toast.error("Failed to load configuration.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleTitleChange = useCallback((title: string) => {
    if (title.trim().length === 0) {
      return;
    }
    setRemoteTitle(title);
  }, []);

  const handleClipboardFallback = useCallback(
    (text: string) => {
      void encryptClipboardText(text)
        .then((payload) => {
          setPendingClipboardPayload(payload);
          setClipboardSeq((s) => s + 1);
        })
        .catch((err: unknown) => {
          console.error("Failed to encrypt clipboard text:", err);
          toast.error("Clipboard encryption failed.", { id: "clipboard" });
        });
    },
    [encryptClipboardText],
  );

  const handleClipboardCopy = useCallback((_text: string) => {
    // No-op: the browser clipboard API succeeded, so the pill is unnecessary.
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: clipboardSeq restarts the timer when the same text is re-copied
  useEffect(() => {
    if (pendingClipboardPayload === null) return;
    const timer = setTimeout(
      () => {
        setPendingClipboardPayload(null);
      },
      15 * 60 * 1000,
    );
    return () => clearTimeout(timer);
  }, [pendingClipboardPayload, clipboardSeq]);

  const {
    containerRef,
    connectionStatus,
    sysKeyActive,
    restart,
    reconnect,
    focusSysKeyboard,
    focusTerminalInput,
    sendSoftKeySequence,
    blurTerminalInput,
    attemptPasteFromClipboard,
    pasteTextIntoTerminal,
    getSelectableText,
    getVisibleTerminalText,
    copyTextToClipboard,
    horizontalOverflow,
    containerElement,
  } = useTerminal({
    wsUrl: awaitingStart ? undefined : config?.wsUrl,
    onTitleChange: handleTitleChange,
    onClipboardFallback: handleClipboardFallback,
    onClipboardCopy: handleClipboardCopy,
    fontSize,
    minColumns: effectiveMinColumns,
  });

  const appShellRef = useRef<HTMLDivElement>(null);
  const terminalStageRef = useRef<HTMLDivElement>(null);
  const dockedKeyboardPanelRef = useRef<HTMLElement>(null);
  const scrollbarTrackRef = useRef<HTMLDivElement>(null);
  const scrollbarThumbRef = useRef<HTMLDivElement>(null);
  const scrollbarDraggingRef = useRef(false);
  const scrollbarDragStartXRef = useRef(0);
  const scrollbarDragStartScrollLeftRef = useRef(0);
  const arrowOverlayRef = useRef<HTMLElement>(null);
  const arrowOverlayDragRef = useRef<ArrowOverlayDragRef | null>(null);
  const arrowOverlayDragMovedRef = useRef(false);
  const [arrowOverlayPosition, setArrowOverlayPosition] = useState<{ left: number; top: number } | null>(null);
  const floatingKeyboardRef = useRef<HTMLElement>(null);
  const floatingKeyboardDragRef = useRef<DragRefBase | null>(null);
  const [floatingKeyboardPosition, setFloatingKeyboardPosition] = useState<{ left: number; top: number } | null>(null);
  const [floatingPressedOverlay, setFloatingPressedOverlay] = useState<FloatingPressedOverlay | null>(null);
  const [dockedPressedOverlay, setDockedPressedOverlay] = useState<FloatingPressedOverlay | null>(null);
  const activeSoftKeyPointerIdRef = useRef<number | null>(null);
  const repeatTimerRef = useRef<number | null>(null);
  const repeatIntervalRef = useRef<number | null>(null);
  const repeatModifiersRef = useRef<SoftKeyModifiers | null>(null);

  useEffect(() => {
    const syncViewportLayout = () => {
      const shell = appShellRef.current;
      if (!shell) {
        return;
      }
      const vv = window.visualViewport;
      if (!vv) {
        shell.style.removeProperty("height");
        shell.style.setProperty("--viewport-bottom-compensation", "0px");
        return;
      }

      const layoutHeight = document.documentElement.clientHeight;
      const visibleBottom = vv.offsetTop + vv.height;
      const bottomClip = Math.max(0, layoutHeight - visibleBottom);
      const boundedBottomClip = Math.min(96, Math.round(bottomClip));

      shell.style.height = `${vv.height}px`;
      shell.style.setProperty("--viewport-bottom-compensation", `${boundedBottomClip}px`);
    };

    const onResize = () => {
      syncViewportLayout();
      window.scrollTo(0, 0);
    };

    syncViewportLayout();

    const vv = window.visualViewport;
    if (!vv) {
      return;
    }
    vv.addEventListener("resize", onResize);
    vv.addEventListener("scroll", syncViewportLayout);
    window.addEventListener("orientationchange", onResize);
    return () => {
      vv.removeEventListener("resize", onResize);
      vv.removeEventListener("scroll", syncViewportLayout);
      window.removeEventListener("orientationchange", onResize);
    };
  }, []);

  useEffect(() => {
    const syncDesktopMode = () => {
      setIsDesktopWide(window.innerWidth >= DESKTOP_WIDTH_BREAKPOINT);
    };
    syncDesktopMode();
    window.addEventListener("resize", syncDesktopMode);
    return () => window.removeEventListener("resize", syncDesktopMode);
  }, []);

  const appTitle = config?.appTitle ?? DEFAULT_APP_TITLE;
  const authEnabled = config?.authEnabled ?? true;
  const scrollbarRefreshToken = `${effectiveMinColumns}:${fontSize ?? "auto"}`;

  useEffect(() => {
    document.title = remoteTitle ? `${remoteTitle} | ${appTitle}` : appTitle;
  }, [appTitle, remoteTitle]);

  useEffect(() => {
    if (!selectableTextRef.current || selectableText === null) {
      return;
    }

    const syncScrollToBottom = () => {
      const current = selectableTextRef.current;
      if (current) {
        current.scrollTop = current.scrollHeight;
      }
    };

    // Double rAF + setTimeout to ensure the browser has fully laid out the content.
    let outerRafId: number | null = null;
    let innerRafId: number | null = null;
    outerRafId = requestAnimationFrame(() => {
      innerRafId = requestAnimationFrame(syncScrollToBottom);
    });
    const timerId = setTimeout(() => {
      syncScrollToBottom();
    }, 100);
    return () => {
      if (outerRafId !== null) {
        cancelAnimationFrame(outerRafId);
      }
      if (innerRafId !== null) {
        cancelAnimationFrame(innerRafId);
      }
      clearTimeout(timerId);
    };
  }, [selectableText]);

  useEffect(() => {
    if (pasteHelperText === null) {
      pasteHelperFocusedRef.current = false;
      return;
    }

    if (!pasteHelperRef.current || pasteHelperFocusedRef.current) {
      return;
    }

    pasteHelperRef.current.focus();
    pasteHelperRef.current.setSelectionRange(pasteHelperText.length, pasteHelperText.length);
    pasteHelperFocusedRef.current = true;
  }, [pasteHelperText]);

  useEffect(() => {
    if (softKeysOpen) {
      return;
    }

    setSoftKeyModifiers({
      ...DEFAULT_SOFT_KEY_MODIFIERS,
    });
    setKeyboardScreen("primary");

    if (repeatTimerRef.current !== null) {
      window.clearTimeout(repeatTimerRef.current);
      repeatTimerRef.current = null;
    }
    if (repeatIntervalRef.current !== null) {
      window.clearInterval(repeatIntervalRef.current);
      repeatIntervalRef.current = null;
    }
    repeatModifiersRef.current = null;
  }, [softKeysOpen]);

  useEffect(() => {
    if (softKeysOpen && isDesktopWide) {
      return;
    }
    setFloatingPressedOverlay(null);
    activeSoftKeyPointerIdRef.current = null;
  }, [softKeysOpen, isDesktopWide]);

  useEffect(() => {
    if (softKeysOpen && !isDesktopWide) {
      return;
    }
    setDockedPressedOverlay(null);
    activeSoftKeyPointerIdRef.current = null;
  }, [softKeysOpen, isDesktopWide]);

  const openCopyModePicker = useCallback(() => {
    setPasteHelperText(null);
    setSelectableText(null);
    setOverflowMenuOpen(false);
    setCopyModePickerOpen(true);
  }, []);

  const openSelectableRecentText = useCallback(async () => {
    const text = await getSelectableText();
    if (text.length === 0) {
      return;
    }
    setPasteHelperText(null);
    setCopyModePickerOpen(false);
    setSelectableText(text);
  }, [getSelectableText]);

  const openSelectableVisibleText = useCallback(() => {
    const text = getVisibleTerminalText();
    if (text.length === 0) {
      toast.info("No visible terminal output available.", { id: "copy-visible" });
      return;
    }
    setPasteHelperText(null);
    setCopyModePickerOpen(false);
    setSelectableText(text);
  }, [getVisibleTerminalText]);

  const closeSelectableText = useCallback(() => {
    setCopyModePickerOpen(false);
    setSelectableText(null);
    setPendingClipboardPayload(null);
  }, []);

  const openPendingClipboard = useCallback(() => {
    if (!pendingClipboardPayload) return;
    void decryptClipboardPayload(pendingClipboardPayload)
      .then((text) => {
        setPasteHelperText(null);
        setCopyModePickerOpen(false);
        setSelectableText(text);
        setPendingClipboardPayload(null);
      })
      .catch((err: unknown) => {
        console.error("Failed to decrypt clipboard payload:", err);
        toast.error("Failed to open clipboard data.", { id: "clipboard" });
      });
  }, [pendingClipboardPayload, decryptClipboardPayload]);

  const openPasteHelper = useCallback(() => {
    setCopyModePickerOpen(false);
    setSelectableText(null);
    setPasteHelperText("");
  }, []);

  const closePasteHelper = useCallback(() => {
    pasteHelperFocusedRef.current = false;
    setPasteHelperText(null);
  }, []);

  const handleToolbarPaste = useCallback(async () => {
    const result = await attemptPasteFromClipboard();
    if (result === "pasted") {
      toast.success("Pasted from clipboard.", { id: "paste" });
      focusTerminalInput();
    } else if (result === "fallback-required") {
      openPasteHelper();
    } else if (result === "empty") {
      toast.error("Clipboard is empty.", { id: "paste" });
    } else if (result === "terminal-unavailable") {
      toast.error("Terminal not ready.", { id: "paste" });
    }
  }, [attemptPasteFromClipboard, focusTerminalInput, openPasteHelper]);

  const submitPasteHelperText = useCallback(() => {
    if (pasteHelperText === null) {
      return;
    }
    const pasted = pasteTextIntoTerminal(pasteHelperText);
    if (pasted) {
      toast.success("Pasted text.", { id: "paste" });
      closePasteHelper();
    }
  }, [closePasteHelper, pasteHelperText, pasteTextIntoTerminal]);

  const toggleSoftModifier = useCallback((modifier: SoftModifierName) => {
    setSoftKeyModifiers((previous) => ({
      ...previous,
      [modifier]: !previous[modifier],
    }));
  }, []);

  const toggleKeyboardScreen = useCallback(() => {
    setKeyboardScreen((previous) => (previous === "primary" ? "secondary" : "primary"));
  }, []);

  const clearSoftModifiers = useCallback(() => {
    setSoftKeyModifiers({
      ...DEFAULT_SOFT_KEY_MODIFIERS,
    });
  }, []);

  const stopKeyRepeat = useCallback(() => {
    const hadRepeat = repeatTimerRef.current !== null || repeatIntervalRef.current !== null;
    if (repeatTimerRef.current !== null) {
      window.clearTimeout(repeatTimerRef.current);
      repeatTimerRef.current = null;
    }
    if (repeatIntervalRef.current !== null) {
      window.clearInterval(repeatIntervalRef.current);
      repeatIntervalRef.current = null;
    }
    repeatModifiersRef.current = null;
    if (hadRepeat) {
      clearSoftModifiers();
    }
  }, [clearSoftModifiers]);

  useEffect(() => {
    if (!(softKeysOpen && isDesktopWide)) {
      return;
    }

    const clearFloatingPressedOverlay = (event: PointerEvent) => {
      if (activeSoftKeyPointerIdRef.current === null || event.pointerId !== activeSoftKeyPointerIdRef.current) {
        return;
      }
      stopKeyRepeat();
      setFloatingPressedOverlay(null);
      activeSoftKeyPointerIdRef.current = null;
    };

    window.addEventListener("pointerup", clearFloatingPressedOverlay);
    window.addEventListener("pointercancel", clearFloatingPressedOverlay);
    return () => {
      window.removeEventListener("pointerup", clearFloatingPressedOverlay);
      window.removeEventListener("pointercancel", clearFloatingPressedOverlay);
      activeSoftKeyPointerIdRef.current = null;
    };
  }, [softKeysOpen, isDesktopWide, stopKeyRepeat]);

  useEffect(() => {
    if (!(softKeysOpen && !isDesktopWide)) {
      return;
    }

    const clearDockedPressedOverlay = (event: PointerEvent) => {
      if (activeSoftKeyPointerIdRef.current === null || event.pointerId !== activeSoftKeyPointerIdRef.current) {
        return;
      }
      stopKeyRepeat();
      setDockedPressedOverlay(null);
      activeSoftKeyPointerIdRef.current = null;
    };

    window.addEventListener("pointerup", clearDockedPressedOverlay);
    window.addEventListener("pointercancel", clearDockedPressedOverlay);
    return () => {
      window.removeEventListener("pointerup", clearDockedPressedOverlay);
      window.removeEventListener("pointercancel", clearDockedPressedOverlay);
      activeSoftKeyPointerIdRef.current = null;
    };
  }, [softKeysOpen, isDesktopWide, stopKeyRepeat]);

  const startKeyRepeat = useCallback(
    (key: SoftKeyDefinition) => {
      stopKeyRepeat();

      const capturedModifiers = { ...softKeyModifiers };
      repeatModifiersRef.current = capturedModifiers;

      const fireKey = () => {
        const mods = repeatModifiersRef.current ?? capturedModifiers;
        const sequence = buildSoftKeySequence(key, mods);
        if (sequence.ok) {
          sendSoftKeySequence(sequence.sequence, sequence.description, true);
        }
      };

      fireKey();

      repeatTimerRef.current = window.setTimeout(() => {
        repeatTimerRef.current = null;
        repeatIntervalRef.current = window.setInterval(fireKey, 80);
      }, 400);
    },
    [sendSoftKeySequence, softKeyModifiers, stopKeyRepeat],
  );

  const fetchProcessesText = useCallback(async (): Promise<string> => {
    const res = await fetch("/api/sessions");
    if (!res.ok) {
      throw new Error(`Failed to fetch processes: ${res.status} ${res.statusText}`);
    }
    const data = await res.json();
    const children = (data.children as { pid: number; command: string }[]) ?? [];
    const lines = [`Server PID: ${data.ppid}`, "", `Child processes (${children.length}):`];

    if (children.length === 0) {
      lines.push("  (none)");
    } else {
      for (const c of children) {
        lines.push(`  ${c.pid}  ${c.command}`);
      }
    }

    return lines.join("\n");
  }, []);

  const inspectProcesses = useCallback(async () => {
    try {
      setProcessesText(await fetchProcessesText());
    } catch {
      toast.error("Failed to fetch processes.");
    }
  }, [fetchProcessesText]);

  const refreshProcesses = useCallback(async () => {
    try {
      setProcessesText(await fetchProcessesText());
    } catch {
      toast.error("Failed to refresh processes.");
    }
  }, [fetchProcessesText]);

  const syncScrollbarThumb = useCallback(() => {
    const track = scrollbarTrackRef.current;
    const thumb = scrollbarThumbRef.current;
    const viewport = containerElement;
    if (!track || !thumb || !viewport) {
      return;
    }

    const scrollWidth = viewport.scrollWidth;
    const clientWidth = viewport.clientWidth;
    if (scrollWidth <= clientWidth) {
      return;
    }

    const trackWidth = track.clientWidth;
    const thumbWidth = Math.max(20, (clientWidth / scrollWidth) * trackWidth);
    const maxScrollLeft = scrollWidth - clientWidth;
    const scrollRatio = maxScrollLeft > 0 ? viewport.scrollLeft / maxScrollLeft : 0;
    const maxThumbLeft = trackWidth - thumbWidth;

    thumb.style.width = `${thumbWidth}px`;
    thumb.style.left = `${scrollRatio * maxThumbLeft}px`;
  }, [containerElement]);

  useEffect(() => {
    const viewport = containerElement;
    if (!viewport || !horizontalOverflow) {
      return;
    }

    syncScrollbarThumb();
    viewport.addEventListener("scroll", syncScrollbarThumb);
    return () => viewport.removeEventListener("scroll", syncScrollbarThumb);
  }, [containerElement, horizontalOverflow, syncScrollbarThumb]);

  useEffect(() => {
    if (!containerElement || !horizontalOverflow || scrollbarRefreshToken.length === 0) {
      return;
    }
    const raf = window.requestAnimationFrame(() => {
      syncScrollbarThumb();
    });
    return () => window.cancelAnimationFrame(raf);
  }, [containerElement, horizontalOverflow, syncScrollbarThumb, scrollbarRefreshToken]);

  const clampOverlayPosition = useCallback((left: number, top: number, stageRect: DOMRect, overlayRect: DOMRect) => {
    const maxLeft = Math.max(0, stageRect.width - overlayRect.width);
    const maxTop = Math.max(0, stageRect.height - overlayRect.height);
    return {
      left: Math.min(Math.max(0, left), maxLeft),
      top: Math.min(Math.max(0, top), maxTop),
    };
  }, []);

  const updateArrowOverlayPosition = useCallback(
    (clientX: number, clientY: number) => {
      const dragState = arrowOverlayDragRef.current;
      const stage = terminalStageRef.current;
      const overlay = arrowOverlayRef.current;
      if (!dragState || !stage || !overlay) {
        return;
      }

      const stageRect = stage.getBoundingClientRect();
      const overlayRect = overlay.getBoundingClientRect();
      const nextLeft = clientX - stageRect.left - dragState.offsetX;
      const nextTop = clientY - stageRect.top - dragState.offsetY;
      setArrowOverlayPosition(clampOverlayPosition(nextLeft, nextTop, stageRect, overlayRect));
    },
    [clampOverlayPosition],
  );

  const startArrowOverlayDrag = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      event.preventDefault();
      event.stopPropagation();
      const stage = terminalStageRef.current;
      const overlay = arrowOverlayRef.current;
      if (!stage || !overlay) {
        return;
      }

      const stageRect = stage.getBoundingClientRect();
      const overlayRect = overlay.getBoundingClientRect();
      const nextPosition = clampOverlayPosition(
        overlayRect.left - stageRect.left,
        overlayRect.top - stageRect.top,
        stageRect,
        overlayRect,
      );
      setArrowOverlayPosition(nextPosition);
      arrowOverlayDragMovedRef.current = false;
      arrowOverlayDragRef.current = {
        pointerId: event.pointerId,
        offsetX: event.clientX - overlayRect.left,
        offsetY: event.clientY - overlayRect.top,
        startX: event.clientX,
        startY: event.clientY,
      };
    },
    [clampOverlayPosition],
  );

  const updateFloatingKeyboardPosition = useCallback(
    (clientX: number, clientY: number) => {
      const dragState = floatingKeyboardDragRef.current;
      const stage = terminalStageRef.current;
      const keyboard = floatingKeyboardRef.current;
      if (!dragState || !stage || !keyboard) {
        return;
      }

      const stageRect = stage.getBoundingClientRect();
      const keyboardRect = keyboard.getBoundingClientRect();
      const nextLeft = clientX - stageRect.left - dragState.offsetX;
      const nextTop = clientY - stageRect.top - dragState.offsetY;
      setFloatingKeyboardPosition(clampOverlayPosition(nextLeft, nextTop, stageRect, keyboardRect));
    },
    [clampOverlayPosition],
  );

  const startFloatingKeyboardDrag = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      event.preventDefault();
      event.stopPropagation();
      const stage = terminalStageRef.current;
      const keyboard = floatingKeyboardRef.current;
      if (!stage || !keyboard) {
        return;
      }

      const stageRect = stage.getBoundingClientRect();
      const keyboardRect = keyboard.getBoundingClientRect();
      const nextPosition = clampOverlayPosition(
        keyboardRect.left - stageRect.left,
        keyboardRect.top - stageRect.top,
        stageRect,
        keyboardRect,
      );
      setFloatingKeyboardPosition(nextPosition);
      floatingKeyboardDragRef.current = {
        pointerId: event.pointerId,
        offsetX: event.clientX - keyboardRect.left,
        offsetY: event.clientY - keyboardRect.top,
      };
    },
    [clampOverlayPosition],
  );

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      const dragState = arrowOverlayDragRef.current;
      if (!dragState || event.pointerId !== dragState.pointerId) {
        return;
      }
      event.preventDefault();
      if (!arrowOverlayDragMovedRef.current) {
        const deltaX = event.clientX - dragState.startX;
        const deltaY = event.clientY - dragState.startY;
        if (Math.hypot(deltaX, deltaY) < OVERLAY_DRAG_ACTIVATION_PX) {
          return;
        }
        if (repeatTimerRef.current !== null) {
          window.clearTimeout(repeatTimerRef.current);
          repeatTimerRef.current = null;
        }
        if (repeatIntervalRef.current !== null) {
          window.clearInterval(repeatIntervalRef.current);
          repeatIntervalRef.current = null;
        }
      }
      arrowOverlayDragMovedRef.current = true;
      updateArrowOverlayPosition(event.clientX, event.clientY);
    };

    const stopDrag = (event: PointerEvent) => {
      const dragState = arrowOverlayDragRef.current;
      if (!dragState || event.pointerId !== dragState.pointerId) {
        return;
      }
      arrowOverlayDragRef.current = null;
    };

    window.addEventListener("pointermove", handlePointerMove, { passive: false });
    window.addEventListener("pointerup", stopDrag);
    window.addEventListener("pointercancel", stopDrag);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", stopDrag);
      window.removeEventListener("pointercancel", stopDrag);
    };
  }, [updateArrowOverlayPosition]);

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      const dragState = floatingKeyboardDragRef.current;
      if (!dragState || event.pointerId !== dragState.pointerId) {
        return;
      }
      event.preventDefault();
      updateFloatingKeyboardPosition(event.clientX, event.clientY);
    };

    const stopDrag = (event: PointerEvent) => {
      const dragState = floatingKeyboardDragRef.current;
      if (!dragState || event.pointerId !== dragState.pointerId) {
        return;
      }
      floatingKeyboardDragRef.current = null;
    };

    window.addEventListener("pointermove", handlePointerMove, { passive: false });
    window.addEventListener("pointerup", stopDrag);
    window.addEventListener("pointercancel", stopDrag);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", stopDrag);
      window.removeEventListener("pointercancel", stopDrag);
    };
  }, [updateFloatingKeyboardPosition]);

  useEffect(() => {
    const clampPosition = () => {
      setArrowOverlayPosition((previous) => {
        if (!previous) {
          return previous;
        }
        const stage = terminalStageRef.current;
        const overlay = arrowOverlayRef.current;
        if (!stage || !overlay) {
          return previous;
        }
        const stageRect = stage.getBoundingClientRect();
        const overlayRect = overlay.getBoundingClientRect();
        return clampOverlayPosition(previous.left, previous.top, stageRect, overlayRect);
      });
      setFloatingKeyboardPosition((previous) => {
        if (!previous) {
          return previous;
        }
        const stage = terminalStageRef.current;
        const keyboard = floatingKeyboardRef.current;
        if (!stage || !keyboard) {
          return previous;
        }
        const stageRect = stage.getBoundingClientRect();
        const keyboardRect = keyboard.getBoundingClientRect();
        return clampOverlayPosition(previous.left, previous.top, stageRect, keyboardRect);
      });
    };

    window.addEventListener("resize", clampPosition);
    return () => window.removeEventListener("resize", clampPosition);
  }, [clampOverlayPosition]);

  useEffect(() => {
    if (!arrowOverlayEnabled) return;
    const frameId = requestAnimationFrame(() => {
      setArrowOverlayPosition((previous) => {
        if (!previous) return previous;
        const stage = terminalStageRef.current;
        const overlay = arrowOverlayRef.current;
        if (!stage || !overlay) return previous;
        const stageRect = stage.getBoundingClientRect();
        const overlayRect = overlay.getBoundingClientRect();
        return clampOverlayPosition(previous.left, previous.top, stageRect, overlayRect);
      });
    });
    return () => {
      cancelAnimationFrame(frameId);
    };
  }, [arrowOverlayEnabled, clampOverlayPosition]);

  useEffect(() => {
    if (!softKeysOpen) return;
    const frameId = requestAnimationFrame(() => {
      setArrowOverlayPosition((previous) => {
        if (!previous) return previous;
        const stage = terminalStageRef.current;
        const overlay = arrowOverlayRef.current;
        if (!stage || !overlay) return previous;
        const stageRect = stage.getBoundingClientRect();
        const overlayRect = overlay.getBoundingClientRect();
        return clampOverlayPosition(previous.left, previous.top, stageRect, overlayRect);
      });
    });
    return () => {
      cancelAnimationFrame(frameId);
    };
  }, [softKeysOpen, clampOverlayPosition]);

  useEffect(() => {
    if (!softKeysOpen || !isDesktopWide) {
      floatingKeyboardDragRef.current = null;
      return;
    }

    const frameId = requestAnimationFrame(() => {
      setFloatingKeyboardPosition((previous) => {
        const stage = terminalStageRef.current;
        const keyboard = floatingKeyboardRef.current;
        if (!stage || !keyboard) {
          return previous;
        }
        const stageRect = stage.getBoundingClientRect();
        const keyboardRect = keyboard.getBoundingClientRect();
        if (previous === null) {
          const inset = 12;
          const defaultLeft = stageRect.width - keyboardRect.width - inset;
          const defaultTop = stageRect.height - keyboardRect.height - inset;
          return clampOverlayPosition(defaultLeft, defaultTop, stageRect, keyboardRect);
        }
        return clampOverlayPosition(previous.left, previous.top, stageRect, keyboardRect);
      });
    });

    return () => {
      cancelAnimationFrame(frameId);
    };
  }, [softKeysOpen, isDesktopWide, clampOverlayPosition]);

  useEffect(() => {
    if (!isDesktopWide) {
      return;
    }
    arrowOverlayDragRef.current = null;
  }, [isDesktopWide]);

  const handleScrollbarPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.setPointerCapture(event.pointerId);
      scrollbarDraggingRef.current = true;
      scrollbarDragStartXRef.current = event.clientX;
      scrollbarDragStartScrollLeftRef.current = containerElement?.scrollLeft ?? 0;
    },
    [containerElement],
  );

  const handleScrollbarPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!scrollbarDraggingRef.current) {
        return;
      }
      event.preventDefault();

      const track = scrollbarTrackRef.current;
      const thumb = scrollbarThumbRef.current;
      const viewport = containerElement;
      if (!track || !thumb || !viewport) {
        return;
      }

      const scrollWidth = viewport.scrollWidth;
      const clientWidth = viewport.clientWidth;
      const maxScrollLeft = scrollWidth - clientWidth;
      if (maxScrollLeft <= 0) {
        return;
      }

      const trackWidth = track.clientWidth;
      const thumbWidth = thumb.clientWidth;
      const maxThumbTravel = trackWidth - thumbWidth;
      if (maxThumbTravel <= 0) {
        return;
      }

      const deltaX = event.clientX - scrollbarDragStartXRef.current;
      const scaleFactor = maxScrollLeft / maxThumbTravel;
      viewport.scrollLeft = scrollbarDragStartScrollLeftRef.current + deltaX * scaleFactor;
    },
    [containerElement],
  );

  const handleScrollbarPointerUp = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!scrollbarDraggingRef.current) {
      return;
    }
    event.preventDefault();
    scrollbarDraggingRef.current = false;
  }, []);

  function handleLogout() {
    fetch("/api/auth/logout", { method: "POST" }).finally(() => {
      window.location.href = "/login";
    });
  }

  const handleFloatingVisualPressStart = useCallback(
    (key: SoftKeyDefinition, buttonEl: HTMLButtonElement, pointerId: number) => {
      if (!(softKeysOpen && isDesktopWide)) {
        return;
      }
      activeSoftKeyPointerIdRef.current = pointerId;
      const stage = terminalStageRef.current;
      if (!stage) {
        return;
      }

      const keyRect = buttonEl.getBoundingClientRect();
      const stageRect = stage.getBoundingClientRect();
      setFloatingPressedOverlay({
        left: keyRect.left - stageRect.left,
        top: keyRect.top - stageRect.top,
        width: keyRect.width,
        height: keyRect.height,
        text: softKeyLabel(key, softKeyModifiers.shift),
      });
    },
    [softKeysOpen, isDesktopWide, softKeyModifiers.shift],
  );

  const handleFloatingVisualPressEnd = useCallback(() => {
    setFloatingPressedOverlay(null);
    activeSoftKeyPointerIdRef.current = null;
  }, []);

  const handleDockedVisualPressStart = useCallback(
    (key: SoftKeyDefinition, buttonEl: HTMLButtonElement, pointerId: number) => {
      if (!(softKeysOpen && !isDesktopWide)) {
        return;
      }
      activeSoftKeyPointerIdRef.current = pointerId;
      const panel = dockedKeyboardPanelRef.current;
      if (!panel) {
        return;
      }

      const keyRect = buttonEl.getBoundingClientRect();
      const panelRect = panel.getBoundingClientRect();
      setDockedPressedOverlay({
        left: keyRect.left - panelRect.left,
        top: keyRect.top - panelRect.top,
        width: keyRect.width,
        height: keyRect.height,
        text: softKeyLabel(key, softKeyModifiers.shift),
      });
    },
    [softKeysOpen, isDesktopWide, softKeyModifiers.shift],
  );

  const handleDockedVisualPressEnd = useCallback(() => {
    setDockedPressedOverlay(null);
    activeSoftKeyPointerIdRef.current = null;
  }, []);

  const showFloatingSoftKeyboard = softKeysOpen && isDesktopWide;
  const showDockedSoftKeyboard = softKeysOpen && !isDesktopWide;
  const showArrowOverlay = !isDesktopWide;
  const showDesktopSoftKeyboardCollapsedToggle = isDesktopWide && !softKeysOpen;

  const arrowOverlayStyle =
    arrowOverlayPosition === null
      ? undefined
      : {
          left: `${arrowOverlayPosition.left}px`,
          top: `${arrowOverlayPosition.top}px`,
          right: "auto",
          bottom: "auto",
        };

  const floatingKeyboardStyle =
    floatingKeyboardPosition === null
      ? undefined
      : {
          left: `${floatingKeyboardPosition.left}px`,
          top: `${floatingKeyboardPosition.top}px`,
          right: "auto",
          bottom: "auto",
        };

  const floatingPressedOverlayStyle =
    floatingPressedOverlay === null
      ? undefined
      : {
          left: `${floatingPressedOverlay.left}px`,
          top: `${floatingPressedOverlay.top}px`,
          width: `${floatingPressedOverlay.width}px`,
          height: `${floatingPressedOverlay.height}px`,
        };

  const dockedPressedOverlayStyle =
    dockedPressedOverlay === null
      ? undefined
      : {
          left: `${dockedPressedOverlay.left}px`,
          top: `${dockedPressedOverlay.top}px`,
          width: `${dockedPressedOverlay.width}px`,
          height: `${dockedPressedOverlay.height}px`,
        };

  const desktopSoftKeyboardToggleStyle = isDesktopWide
    ? arrowOverlayPosition === null
      ? {
          left: "auto",
          top: "auto",
          right: "0.75rem",
          bottom: "0.75rem",
          display: "flex",
        }
      : {
          left: `${arrowOverlayPosition.left}px`,
          top: `${arrowOverlayPosition.top}px`,
          right: "auto",
          bottom: "auto",
          display: "flex",
        }
    : undefined;

  return (
    <div className="app-shell" ref={appShellRef}>
      <header className="topbar">
        <div className="brand">
          <h1>
            <span className="brand-title">{appTitle}</span>
            <button type="button" className="info-button" onClick={() => setInfoDialogOpen(true)} aria-label="Info">
              i
            </button>
            {(() => {
              const statusLabel =
                connectionStatus === "connected"
                  ? "Connected"
                  : connectionStatus === "connecting"
                    ? "Connecting"
                    : connectionStatus === "error"
                      ? "Error"
                      : "Disconnected";
              return (
                <>
                  <span className={`status-dot status-dot-${connectionStatus} touch-only`} aria-hidden="true" />
                  <span
                    className={`status-badge status-${connectionStatus} pointer-only`}
                    role="status"
                    aria-label={statusLabel}
                  >
                    {connectionStatus === "connecting" ? "..." : connectionStatus}
                  </span>
                </>
              );
            })()}
            {pendingClipboardPayload === null ? (
              <span className="status-badge clipboard-pending-badge clipboard-idle" style={{ visibility: "hidden" }}>
                <span className="btn-icon">📋</span>
                <span className="btn-label">Clipboard</span>
              </span>
            ) : (
              <button
                key={clipboardSeq}
                type="button"
                className="status-badge clipboard-pending-badge"
                onClick={openPendingClipboard}
              >
                <span className="btn-icon">📋</span>
                <span className="btn-label">Clipboard</span>
              </button>
            )}
          </h1>
        </div>
        <div className="toolbar">
          <div
            className="toolbar-actions"
            role="toolbar"
            // Prevent default on mouse/touch so that pressing toolbar buttons
            // doesn't trigger text selection or steal focus from the terminal.
            onMouseDown={(e) => e.preventDefault()}
            onTouchStart={(e) => e.preventDefault()}
          >
            <button
              type="button"
              className={`toolbar-button ${softKeysOpen ? "toolbar-button-active" : ""}`}
              onClick={() => {
                setSoftKeysOpen((previous) => {
                  const nextOpen = !previous;
                  if (nextOpen) {
                    blurTerminalInput();
                  } else {
                    focusTerminalInput();
                  }
                  return nextOpen;
                });
                setOverflowMenuOpen(false);
              }}
              aria-pressed={softKeysOpen}
            >
              <svg
                className="btn-icon"
                aria-hidden="true"
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <rect x="2" y="4" width="20" height="16" rx="2" />
                <path d="M6 8h.01M10 8h.01M14 8h.01M18 8h.01" />
                <path d="M6 12h.01M10 12h.01M14 12h.01M18 12h.01" />
                <path d="M8 16h8" />
              </svg>
              <span className="btn-label">Soft Keys</span>
            </button>
            <div className="copy-mode-menu" ref={copyModeMenuRef}>
              <button
                type="button"
                className={`toolbar-button ${copyModePickerOpen ? "toolbar-button-active" : ""}`}
                onClick={openCopyModePicker}
                title="Copy Text"
                aria-expanded={copyModePickerOpen}
                aria-haspopup="menu"
              >
                <svg
                  className="btn-icon"
                  aria-hidden="true"
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <rect x="9" y="9" width="13" height="13" rx="2" />
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                </svg>
                <span className="btn-label">Copy Text</span>
              </button>
              {copyModePickerOpen && (
                <div className="dropdown-panel copy-mode-menu-panel" role="menu" aria-label="Choose copy source">
                  <button
                    type="button"
                    className="toolbar-button copy-mode-menu-item"
                    role="menuitem"
                    onClick={() => void openSelectableRecentText()}
                  >
                    Recent Output
                  </button>
                  <button
                    type="button"
                    className="toolbar-button copy-mode-menu-item"
                    role="menuitem"
                    onClick={openSelectableVisibleText}
                  >
                    Visible Screen
                  </button>
                </div>
              )}
            </div>
            <button
              type="button"
              className="toolbar-button"
              onClick={() => void handleToolbarPaste()}
              title="Paste from clipboard. If blocked, a helper panel opens for iOS paste."
            >
              <svg
                className="btn-icon"
                aria-hidden="true"
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
                <rect x="8" y="2" width="8" height="4" rx="1" />
                <path d="M12 11v6" />
                <path d="M9 14l3-3 3 3" />
              </svg>
              <span className="btn-label">Paste Text</span>
            </button>
            <div className="overflow-menu" ref={overflowMenuRef}>
              <button
                type="button"
                className="toolbar-button overflow-menu-trigger"
                onClick={() => setOverflowMenuOpen((prev) => !prev)}
                aria-expanded={overflowMenuOpen}
                aria-label="More actions"
              >
                &#8942;
              </button>
              {overflowMenuOpen && (
                <div className="dropdown-panel overflow-menu-panel">
                  <button
                    type="button"
                    className={`toolbar-button overflow-menu-item touch-only ${sysKeyActive ? "toolbar-button-active" : ""}`}
                    onClick={() =>
                      overflowAction(() => {
                        setSoftKeysOpen(false);
                        focusSysKeyboard();
                      })
                    }
                  >
                    Sys Keys
                  </button>
                  <button
                    type="button"
                    className="toolbar-button overflow-menu-item touch-only"
                    onClick={() => overflowAction(() => void inspectProcesses())}
                  >
                    Processes
                  </button>
                  {connectionStatus === "connected" ? (
                    <button
                      type="button"
                      className="toolbar-button overflow-menu-item touch-only"
                      onClick={() =>
                        overflowAction(() => {
                          if (window.confirm("Restart terminal session?")) {
                            setProcessesText(null);
                            restart();
                          }
                        })
                      }
                    >
                      Restart
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="toolbar-button overflow-menu-item reconnect-button touch-only"
                      onClick={() => overflowAction(reconnect)}
                      disabled={connectionStatus === "connecting"}
                    >
                      Reconnect
                    </button>
                  )}
                  <button
                    type="button"
                    className="toolbar-button overflow-menu-item"
                    onClick={() => overflowAction(openFontSizeMenu)}
                  >
                    Font Size: {fontSize ?? "Auto"}
                  </button>
                  <button
                    type="button"
                    className="toolbar-button overflow-menu-item"
                    onClick={() => overflowAction(openMinColumnsMenu)}
                  >
                    Min Cols: {effectiveMinColumns}
                  </button>
                  {authEnabled ? (
                    <button
                      type="button"
                      className="toolbar-button overflow-menu-item logout-button touch-only"
                      onClick={() => overflowAction(handleLogout)}
                    >
                      Log Out
                    </button>
                  ) : null}
                </div>
              )}
            </div>
            <button type="button" className="toolbar-button pointer-only" onClick={() => void inspectProcesses()}>
              Processes
            </button>
            {connectionStatus === "connected" ? (
              <button
                type="button"
                className="toolbar-button pointer-only"
                onClick={() => {
                  if (window.confirm("Restart terminal session?")) {
                    setProcessesText(null);
                    restart();
                  }
                }}
              >
                Restart
              </button>
            ) : (
              <button
                type="button"
                className="toolbar-button reconnect-button pointer-only"
                onClick={reconnect}
                disabled={connectionStatus === "connecting"}
              >
                Reconnect
              </button>
            )}
            {authEnabled ? (
              <button type="button" className="toolbar-button pointer-only logout-button" onClick={handleLogout}>
                Log Out
              </button>
            ) : null}
          </div>
        </div>
      </header>

      <main className="terminal-card">
        <div className="terminal-stage" ref={terminalStageRef}>
          <div
            ref={containerRef}
            className={`terminal-viewport ${horizontalOverflow ? "terminal-viewport-overflow" : ""}`}
          />

          {awaitingStart ? (
            <div
              className="disconnect-overlay"
              role="button"
              tabIndex={0}
              ref={startOverlayRef}
              onClick={() => setAwaitingStart(false)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  setAwaitingStart(false);
                }
              }}
            >
              {sessionStorage.getItem(SESSION_STORAGE_KEY) !== null ? (
                <div className="disconnect-overlay-text start-overlay-text start-overlay-resume">
                  <span>
                    <span className="pointer-only">Click or press Enter to</span>
                    <span className="touch-only">Tap to</span> resume
                  </span>
                </div>
              ) : (
                <div className="disconnect-overlay-text start-overlay-text">
                  <code className="start-overlay-command">{formatShellCommand(config?.shellCommand ?? [])}</code>
                  <span>
                    <span className="pointer-only">Click or press Enter to</span>
                    <span className="touch-only">Tap to</span> start
                  </span>
                </div>
              )}
            </div>
          ) : (
            connectionStatus !== "connected" &&
            (connectionStatus === "connecting" ? (
              <div className="disconnect-overlay">
                <p className="disconnect-overlay-text disconnect-overlay-connecting">Connecting...</p>
              </div>
            ) : (
              <div
                className="disconnect-overlay"
                role="button"
                tabIndex={0}
                onClick={() => reconnect()}
                onKeyDown={(e) => {
                  if (e.key === " " || e.key === "Enter") {
                    e.preventDefault();
                    reconnect();
                  }
                }}
              >
                <p className="disconnect-overlay-text">
                  <span className="pointer-only">Click or press Space to</span>
                  <span className="touch-only">Tap to</span> reconnect
                </p>
              </div>
            ))
          )}

          {horizontalOverflow && (
            <div className="custom-scrollbar">
              <div className="custom-scrollbar-track" ref={scrollbarTrackRef}>
                <div
                  className="custom-scrollbar-thumb"
                  ref={scrollbarThumbRef}
                  onPointerDown={handleScrollbarPointerDown}
                  onPointerMove={handleScrollbarPointerMove}
                  onPointerUp={handleScrollbarPointerUp}
                  onPointerCancel={handleScrollbarPointerUp}
                  onLostPointerCapture={handleScrollbarPointerUp}
                />
              </div>
            </div>
          )}

          {showFloatingSoftKeyboard && (
            <section
              className="extra-keys-panel extra-keys-floating"
              role="group"
              aria-label="Soft keyboard"
              ref={floatingKeyboardRef}
              style={floatingKeyboardStyle}
            >
              <div className="extra-keys-floating-toolbar">
                <div className="extra-keys-floating-toolbar-spacer" />
                <button
                  type="button"
                  className="extra-keys-floating-drag-handle"
                  aria-label="Drag soft keyboard"
                  onPointerDown={startFloatingKeyboardDrag}
                >
                  ⠿
                </button>
                <button
                  type="button"
                  className="extra-keys-floating-close"
                  aria-label="Close soft keyboard"
                  onClick={() => {
                    if (!floatingKeyboardDragRef.current) {
                      setSoftKeysOpen(false);
                      focusTerminalInput();
                    }
                  }}
                >
                  ✕
                </button>
              </div>
              <DesktopPcKeyboardGrid
                softKeyModifiers={softKeyModifiers}
                toggleSoftModifier={toggleSoftModifier}
                startKeyRepeat={startKeyRepeat}
                stopKeyRepeat={stopKeyRepeat}
                onVisualPressStart={handleFloatingVisualPressStart}
                onVisualPressEnd={handleFloatingVisualPressEnd}
              />
            </section>
          )}

          {showFloatingSoftKeyboard && floatingPressedOverlay && (
            <div className="floating-keypress-overlay" style={floatingPressedOverlayStyle} aria-hidden="true">
              {floatingPressedOverlay.text}
            </div>
          )}

          {showDesktopSoftKeyboardCollapsedToggle && (
            <button
              type="button"
              className="arrow-overlay arrow-overlay-collapsed soft-keys-collapsed-desktop-toggle"
              aria-label="Show soft keyboard"
              ref={arrowOverlayRef as React.RefObject<HTMLButtonElement>}
              style={desktopSoftKeyboardToggleStyle}
              onPointerDown={startArrowOverlayDrag}
              onClick={() => {
                if (!arrowOverlayDragMovedRef.current) {
                  setSoftKeysOpen(true);
                  blurTerminalInput();
                }
              }}
            >
              <span className="arrow-overlay-collapsed-icon soft-keys-collapsed-desktop-icon" aria-hidden="true">
                ⌨︎
              </span>
            </button>
          )}

          {showArrowOverlay &&
            (arrowOverlayEnabled ? (
              <div
                className="arrow-overlay"
                role="group"
                aria-label="Arrow controls"
                ref={arrowOverlayRef as React.RefObject<HTMLDivElement>}
                style={arrowOverlayStyle}
              >
                <div className="arrow-overlay-toolbar">
                  <div className="arrow-overlay-toolbar-spacer" />
                  <button
                    type="button"
                    className="arrow-overlay-drag-handle"
                    aria-label="Drag arrow controls"
                    onPointerDown={startArrowOverlayDrag}
                  >
                    ⠿
                  </button>
                  <button
                    type="button"
                    className="arrow-overlay-close"
                    aria-label="Close arrow controls"
                    onClick={() => {
                      if (!arrowOverlayDragRef.current) {
                        setArrowOverlayEnabled(false);
                      }
                    }}
                  >
                    ✕
                  </button>
                </div>
                <div className="arrow-overlay-grid">
                  <div className="arrow-overlay-spacer" />
                  <ArrowKeyButton
                    softKey={OVERLAY_ARROW_UP}
                    ariaLabel="Arrow Up"
                    startKeyRepeat={startKeyRepeat}
                    stopKeyRepeat={stopKeyRepeat}
                  />
                  <div className="arrow-overlay-spacer" />
                  <ArrowKeyButton
                    softKey={OVERLAY_ARROW_LEFT}
                    ariaLabel="Arrow Left"
                    startKeyRepeat={startKeyRepeat}
                    stopKeyRepeat={stopKeyRepeat}
                  />
                  <ArrowKeyButton
                    softKey={OVERLAY_ARROW_DOWN}
                    ariaLabel="Arrow Down"
                    startKeyRepeat={startKeyRepeat}
                    stopKeyRepeat={stopKeyRepeat}
                  />
                  <ArrowKeyButton
                    softKey={OVERLAY_ARROW_RIGHT}
                    ariaLabel="Arrow Right"
                    startKeyRepeat={startKeyRepeat}
                    stopKeyRepeat={stopKeyRepeat}
                  />
                </div>
              </div>
            ) : (
              <button
                type="button"
                className="arrow-overlay arrow-overlay-collapsed"
                aria-label="Show arrow controls"
                ref={arrowOverlayRef as React.RefObject<HTMLButtonElement>}
                style={arrowOverlayStyle}
                onPointerDown={startArrowOverlayDrag}
                onClick={() => {
                  if (!arrowOverlayDragMovedRef.current) {
                    setArrowOverlayEnabled(true);
                  }
                }}
              >
                <span className="arrow-overlay-collapsed-icon" aria-hidden="true">
                  ✥
                </span>
              </button>
            ))}
        </div>
      </main>

      {showDockedSoftKeyboard && (
        <section
          className="extra-keys-panel extra-keys-docked"
          aria-label="Extra key controls"
          ref={dockedKeyboardPanelRef}
        >
          <MobileSoftKeyboardGrid
            keyboardScreen={keyboardScreen}
            softKeyModifiers={softKeyModifiers}
            toggleSoftModifier={toggleSoftModifier}
            toggleKeyboardScreen={toggleKeyboardScreen}
            startKeyRepeat={startKeyRepeat}
            stopKeyRepeat={stopKeyRepeat}
            onVisualPressStart={handleDockedVisualPressStart}
            onVisualPressEnd={handleDockedVisualPressEnd}
          />
          {dockedPressedOverlay && (
            <div
              className="floating-keypress-overlay compact-keypress-overlay"
              style={dockedPressedOverlayStyle}
              aria-hidden="true"
            >
              {dockedPressedOverlay.text}
            </div>
          )}
        </section>
      )}

      {selectableText !== null &&
        (() => {
          const lineCount = selectableText.split("\n").length;
          return (
            <section className="copy-sheet" aria-label="Selectable terminal text">
              <div className="copy-sheet-header">
                <h2>
                  Select Text To Copy ({lineCount} line{lineCount === 1 ? "" : "s"})
                </h2>
                <div style={{ display: "flex", gap: "6px" }}>
                  <button
                    type="button"
                    className="toolbar-button"
                    onClick={async () => {
                      try {
                        const ok = await copyTextToClipboard(selectableText);
                        if (ok) {
                          toast.success(`Copied ${lineCount} line${lineCount === 1 ? "" : "s"}.`, { id: "copy" });
                        } else {
                          toast.error("Clipboard copy failed.", { id: "copy" });
                        }
                      } catch {
                        toast.error("Clipboard copy failed.", { id: "copy" });
                      }
                    }}
                  >
                    Copy All
                  </button>
                  <button type="button" className="toolbar-button" onClick={closeSelectableText}>
                    Close
                  </button>
                </div>
              </div>
              <textarea
                ref={selectableTextRef}
                className="copy-sheet-textarea"
                value={selectableText}
                readOnly
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                inputMode="none"
              />
              <p className="copy-sheet-hint">Use native touch selection handles here, then copy.</p>
            </section>
          );
        })()}

      {pasteHelperText !== null && (
        <section className="copy-sheet" aria-label="Paste helper">
          <div className="copy-sheet-header">
            <h2>Paste Into Terminal</h2>
            <button type="button" className="toolbar-button" onClick={closePasteHelper}>
              Close
            </button>
          </div>
          <p className="copy-sheet-hint">Long-press in this field, tap Paste, then Send.</p>
          <textarea
            ref={pasteHelperRef}
            className="copy-sheet-textarea"
            value={pasteHelperText}
            onChange={(event) => setPasteHelperText(event.target.value)}
            spellCheck={false}
          />
          <div className="copy-sheet-actions">
            <button
              type="button"
              className="toolbar-button"
              onClick={submitPasteHelperText}
              disabled={pasteHelperText.trim().length === 0}
            >
              Send
            </button>
          </div>
        </section>
      )}

      {processesText !== null && (
        <section className="copy-sheet" aria-label="Processes">
          <div className="copy-sheet-header">
            <h2>Processes</h2>
            <div style={{ display: "flex", gap: "6px" }}>
              <button type="button" className="toolbar-button" onClick={() => void refreshProcesses()}>
                Refresh
              </button>
              <button type="button" className="toolbar-button" onClick={() => setProcessesText(null)}>
                Close
              </button>
            </div>
          </div>
          <p className="copy-sheet-hint">Child processes of the server. Empty after restart = no leaks.</p>
          <textarea className="copy-sheet-textarea" value={processesText} readOnly />
        </section>
      )}
      {infoDialogOpen && (
        <dialog
          className="font-size-dialog-backdrop"
          open
          onClick={(e) => {
            if (e.target === e.currentTarget) setInfoDialogOpen(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") setInfoDialogOpen(false);
          }}
        >
          <div className="info-dialog">
            <p className="info-dialog-title">{appTitle}</p>
            <p className="info-tagline">
              Powered by {DEFAULT_APP_TITLE}
              {config?.version ? ` ${config.version}` : ""}
            </p>
            <div className="info-details">
              <div className="info-detail-row">
                <span className="info-detail-label">Status</span>
                <span className="info-detail-value">
                  <span className={`info-status-indicator status-${connectionStatus}`} />
                  {connectionStatus}
                </span>
              </div>
              <div className="info-detail-row">
                <span className="info-detail-label">WebSocket</span>
                <span className="info-detail-value info-detail-mono">{config?.wsUrl ?? "—"}</span>
              </div>
            </div>
            <button type="button" className="toolbar-button" onClick={() => setInfoDialogOpen(false)}>
              Close
            </button>
          </div>
        </dialog>
      )}
      {fontSizeMenuOpen && (
        <dialog
          className="font-size-dialog-backdrop"
          open
          onClick={(e) => {
            if (e.target === e.currentTarget) closeFontSizeMenu();
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") closeFontSizeMenu();
          }}
        >
          <div className="font-size-dialog">
            <p className="font-size-dialog-label">Font Size</p>
            <div className="font-size-dialog-options">
              <button
                type="button"
                className={`toolbar-button font-size-option ${fontSize === undefined ? "toolbar-button-active" : ""}`}
                onClick={() => {
                  setFontSize(undefined);
                  closeFontSizeMenu();
                }}
              >
                Auto
              </button>
              {[10, 12, 14, 16].map((size) => (
                <button
                  key={size}
                  type="button"
                  className={`toolbar-button font-size-option ${fontSize === size ? "toolbar-button-active" : ""}`}
                  onClick={() => {
                    setFontSize(size);
                    closeFontSizeMenu();
                  }}
                >
                  {size}
                </button>
              ))}
            </div>
          </div>
        </dialog>
      )}
      {minColumnsMenuOpen && (
        <dialog
          className="font-size-dialog-backdrop"
          open
          onClick={(e) => {
            if (e.target === e.currentTarget) closeMinColumnsMenu();
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") closeMinColumnsMenu();
          }}
        >
          <div className="font-size-dialog">
            <p className="font-size-dialog-label">Min Columns</p>
            <div className="font-size-dialog-options">
              <button
                type="button"
                className={`toolbar-button font-size-option ${minColumns === undefined ? "toolbar-button-active" : ""}`}
                onClick={() => {
                  setMinColumns(undefined);
                  closeMinColumnsMenu();
                }}
              >
                Default ({DEFAULT_MIN_COLUMNS})
              </button>
              {MIN_COLUMNS_OPTIONS.filter((columns) => columns > DEFAULT_MIN_COLUMNS).map((columns) => (
                <button
                  key={columns}
                  type="button"
                  className={`toolbar-button font-size-option ${minColumns === columns ? "toolbar-button-active" : ""}`}
                  onClick={() => {
                    setMinColumns(columns);
                    closeMinColumnsMenu();
                  }}
                >
                  {columns}
                </button>
              ))}
            </div>
          </div>
        </dialog>
      )}
      <Toaster position="top-right" theme="dark" duration={3000} />
    </div>
  );
}

export default App;
