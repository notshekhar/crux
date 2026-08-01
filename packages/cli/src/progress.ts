/**
 * The ■■■･･･ 42% download bar, matching install.sh.
 *
 * Same glyphs and the same 256-colour orange, so a fresh install and an
 * in-place upgrade look like one tool rather than two.
 */

const WIDTH = 50;
const FILLED = "■";
const EMPTY = "･";
const COLOR = "\x1b[38;5;215m";
const RESET = "\x1b[0m";
const DIM = "\x1b[2m";

const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const CLEAR_LINE = "\r\x1b[K";

/** A TTY can be redrawn in place; a pipe or CI log cannot. */
export const isInteractive = (): boolean => process.stderr.isTTY === true;

export class ProgressBar {
    private drawn = false;
    private lastPercent = -1;

    constructor(private label: string) {}

    /** Downloads run back to back; the label names whichever is current. */
    setLabel(label: string): void {
        if (label !== this.label) {
            this.label = label;
            this.lastPercent = -1; // force a redraw so the new name appears at once
        }
    }

    /**
     * Redraw. A `total` of 0 means the server sent no content-length, so bytes
     * are reported instead of a percentage — better than a bar that never moves.
     */
    update(received: number, total: number): void {
        if (!isInteractive()) return;

        if (!this.drawn) {
            process.stderr.write(HIDE_CURSOR);
            this.drawn = true;
        }

        if (total <= 0) {
            process.stderr.write(`${CLEAR_LINE}${DIM}${this.label}${RESET} ${(received / 1e6).toFixed(1)} MB`);
            return;
        }

        const percent = Math.min(100, Math.floor((received * 100) / total));
        if (percent === this.lastPercent) return; // redrawing the same frame just flickers
        this.lastPercent = percent;

        const on = Math.floor((percent * WIDTH) / 100);
        const bar = FILLED.repeat(on) + EMPTY.repeat(WIDTH - on);
        process.stderr.write(
            `${CLEAR_LINE}${DIM}${this.label}${RESET} ${COLOR}${bar} ${String(percent).padStart(3)}%${RESET}`,
        );
    }

    /** Clear the line and restore the cursor. Safe to call twice. */
    done(): void {
        if (!this.drawn) return;
        process.stderr.write(`${CLEAR_LINE}${SHOW_CURSOR}`);
        this.drawn = false;
        this.lastPercent = -1;
    }
}

/**
 * Run `fn` with a bar that is always cleaned up.
 *
 * Without the finally, a thrown error leaves the terminal with no cursor.
 */
export async function withProgress<T>(label: string, fn: (bar: ProgressBar) => Promise<T>): Promise<T> {
    const bar = new ProgressBar(label);
    try {
        return await fn(bar);
    } finally {
        bar.done();
    }
}
