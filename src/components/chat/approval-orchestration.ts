// Full approval orchestration for the sort chat shell (S6).
//
// The plan card (W13) owns review-and-exclude and hands off a single trimmed
// snapshot when the user approves. Everything that must happen *behind* that
// approve action — restating the exact mutation, gating a risky plan behind an
// explicit acknowledgment, refusing a non-ready plan, preventing a double
// submit, and refusing to apply a plan that went stale between review and
// submit — lives here as a pure state machine so it can be unit-tested without
// React. `useApprovalOrchestration` is a thin hook that wires the pure core to
// the pane's transcript and (mock) apply engine.
//
// The core never sees a filesystem path: it works over the same display-name /
// opaque `PlanMessage` snapshots the rest of the model uses, and it derives the
// mutation copy and the risk signal from the SAME trimmed snapshot the card
// showed, so the words, the counts, and the folders that get applied can never
// disagree.

import { useCallback, useRef, useState } from "react";

import {
	assertNever,
	type ChatMessage,
	isPlanApprovable,
	type PlanFolder,
	type PlanMessage,
	type PlanStatus,
	planApprovalCopy,
	planBlockReason,
} from "./message-model";

// ── Risk signal ─────────────────────────────────────────────────────────────
// A deliberately minimal, conservative signal: a plan needs acknowledgment when
// it still contains at least one move the model was LESS certain about (S4's
// `lowConfidenceFiles`). No broad risk taxonomy — just the one boolean derived
// from the trimmed snapshot, so excluding every shaky move also clears the gate.

/** True when any destination still carries a low-confidence move (S4). */
export function planHasLowConfidenceMoves(
	folders: readonly PlanFolder[],
): boolean {
	return folders.some((folder) => (folder.lowConfidenceFiles?.length ?? 0) > 0);
}

/** Whether approving this snapshot must pass the risk acknowledgment gate. */
export function planRequiresAcknowledgment(plan: PlanMessage): boolean {
	return planHasLowConfidenceMoves(plan.folders);
}

/** Total number of low-confidence moves across every destination. */
export function planLowConfidenceCount(folders: readonly PlanFolder[]): number {
	return folders.reduce(
		(count, folder) => count + (folder.lowConfidenceFiles?.length ?? 0),
		0,
	);
}

/** One low-confidence move: a display filename and the destination it routes to. */
export interface LowConfidenceMove {
	readonly file: string;
	readonly destination: string;
}

/**
 * Every low-confidence move in the snapshot, paired with its destination so the
 * acknowledgment step can list exactly what the user is being asked to
 * double-check. Display names only — never a filesystem path.
 */
export function planLowConfidenceMoves(
	folders: readonly PlanFolder[],
): LowConfidenceMove[] {
	const moves: LowConfidenceMove[] = [];
	for (const folder of folders) {
		for (const file of folder.lowConfidenceFiles ?? []) {
			moves.push({ file, destination: folder.name });
		}
	}
	return moves;
}

/** Pluralize `count` against `noun` (naive "+s"; enough for the risk copy). */
function plural(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * The risk-warning line shown before a flagged plan is submitted. Derived from
 * the snapshot's own low-confidence count so it can never disagree with the
 * moves the user is asked to double-check.
 */
export function planAcknowledgmentCopy(folders: readonly PlanFolder[]): string {
	const count = planLowConfidenceCount(folders);
	const verb = count === 1 ? "is" : "are";
	return `${plural(count, "move")} ${verb} a less-confident guess. Review the flagged files, then confirm you want to go ahead.`;
}

// ── Version binding ──────────────────────────────────────────────────────────

/**
 * A stable, order-sensitive fingerprint of everything that defines what a plan
 * would apply: its identity, its approval status, and every destination (name,
 * new/existing, and the exact ordered file set). Two snapshots with the same
 * fingerprint would apply identically; any change the user must re-review — a
 * file added or removed, a destination renamed, or the status going stale —
 * yields a different fingerprint. Used to bind an approval to a specific version
 * of the plan so an out-of-date one is never applied. Display names only.
 */
export function planFingerprint(plan: PlanMessage): string {
	// A structured, unambiguous serialization: JSON escapes the display names so
	// two different file lists can never collapse to the same string.
	return JSON.stringify({
		id: plan.id,
		status: plan.status,
		folders: plan.folders.map((folder) => ({
			name: folder.name,
			isNew: folder.isNew,
			files: folder.files,
		})),
	});
}

/**
 * The current state of a bound plan, looked up in the live transcript at submit
 * time. `status` is `"gone"` when the message no longer exists; otherwise it is
 * the plan's live approval status plus a fresh fingerprint of its source.
 */
export interface LiveBinding {
	readonly status: PlanStatus | "gone";
	readonly version: string;
	/** The live plan's explicit block reason, if any, so it can be surfaced. */
	readonly statusReason?: string;
}

/** Default reason when a bound plan is gone or its version drifted at submit. */
const STALE_BINDING_REASON =
	"This plan changed after you reviewed it, so Untie didn't apply the out-of-date version. Regenerate to review the current files.";

/**
 * Why a bound approval must NOT be submitted, or `null` when it is safe to
 * apply. A plan that left the transcript, went to any non-`ready` status, or
 * whose version drifted since it was bound is refused — the reviewed, in-date
 * snapshot is the only thing that ever reaches apply.
 */
function submissionBlockReason(
	pending: PendingApproval,
	live: LiveBinding,
): string | null {
	if (live.status === "gone") return STALE_BINDING_REASON;
	if (live.status !== "ready") {
		return (
			planBlockReason({
				...pending.snapshot,
				status: live.status,
				statusReason: live.statusReason,
			}) ?? STALE_BINDING_REASON
		);
	}
	if (live.version !== pending.version) return STALE_BINDING_REASON;
	return null;
}

// ── State machine ────────────────────────────────────────────────────────────

/**
 * The approval lifecycle:
 * - `idle`: nothing in flight; a fresh approval may be requested.
 * - `confirming-acknowledgment`: a flagged plan is waiting for the user to
 *   explicitly acknowledge its risk before it is submitted.
 * - `submitting`: a submit is in flight; further approvals are no-ops until it
 *   settles (double-submit prevention).
 */
export type ApprovalPhase = "idle" | "confirming-acknowledgment" | "submitting";

/** The approval bound while confirming or submitting. */
export interface PendingApproval {
	/** The exact trimmed snapshot that would be applied (excluded files removed). */
	readonly snapshot: PlanMessage;
	/** The version fingerprint bound when the approval was requested. */
	readonly version: string;
	/** Whether this approval had to pass the risk acknowledgment gate. */
	readonly requiresAcknowledgment: boolean;
}

export interface ApprovalState {
	readonly phase: ApprovalPhase;
	/** The bound approval, present in every phase except `idle`. */
	readonly pending: PendingApproval | null;
	/** Why the last action was refused; cleared as soon as one succeeds. */
	readonly blockedReason: string | null;
}

export const initialApprovalState: ApprovalState = {
	phase: "idle",
	pending: null,
	blockedReason: null,
};

/**
 * The actions the machine accepts.
 * - `approve`: the user approved a trimmed snapshot from the card; `version`
 *   binds the approval to the live plan it was reviewed against.
 * - `acknowledge`: the user confirmed the risk warning; `live` re-validates the
 *   binding against the current transcript before submitting.
 * - `cancel`: dismiss the risk warning without submitting.
 * - `settle`: the in-flight submit finished (success or failure).
 */
export type ApprovalAction =
	| {
			readonly type: "approve";
			readonly snapshot: PlanMessage;
			readonly version: string;
	  }
	| { readonly type: "acknowledge"; readonly live: LiveBinding }
	| { readonly type: "cancel" }
	| { readonly type: "settle" };

/**
 * A side effect the host must run after a transition. The pure core never runs
 * apply itself; it only tells the caller what to do so the machine stays
 * testable in isolation.
 */
export type ApprovalEffect =
	| { readonly type: "none" }
	| { readonly type: "submit"; readonly snapshot: PlanMessage }
	| { readonly type: "blocked"; readonly reason: string };

/** The result of one transition: the next state plus the effect to run. */
export interface ApprovalTransition {
	readonly state: ApprovalState;
	readonly effect: ApprovalEffect;
}

/**
 * The pure reducer at the heart of the orchestration. Given the current state
 * and an action, it returns the next state and the effect the host should run.
 * Every S6 behavior is decided here, so the whole approval lifecycle can be
 * asserted without React.
 */
export function reduceApproval(
	state: ApprovalState,
	action: ApprovalAction,
): ApprovalTransition {
	switch (action.type) {
		case "approve": {
			// Double-submit / re-entrancy guard: only an idle machine takes a new
			// approval. A second approve while confirming or submitting is a no-op.
			if (state.phase !== "idle") {
				return { state, effect: { type: "none" } };
			}
			const { snapshot, version } = action;
			// A non-ready plan can never be approved; refuse it and surface the same
			// reason the card shows (defence in depth — the card already disables it).
			if (!isPlanApprovable(snapshot.status)) {
				const reason =
					planBlockReason(snapshot) ?? "This plan can't be approved.";
				return {
					state: { ...state, blockedReason: reason },
					effect: { type: "blocked", reason },
				};
			}
			const requiresAcknowledgment = planRequiresAcknowledgment(snapshot);
			const pending: PendingApproval = {
				snapshot,
				version,
				requiresAcknowledgment,
			};
			// A flagged plan waits for an explicit acknowledgment; an unflagged one
			// submits straight away.
			if (requiresAcknowledgment) {
				return {
					state: {
						phase: "confirming-acknowledgment",
						pending,
						blockedReason: null,
					},
					effect: { type: "none" },
				};
			}
			return {
				state: { phase: "submitting", pending, blockedReason: null },
				effect: { type: "submit", snapshot },
			};
		}
		case "acknowledge": {
			// Only meaningful while waiting on the risk acknowledgment.
			if (state.phase !== "confirming-acknowledgment" || !state.pending) {
				return { state, effect: { type: "none" } };
			}
			const pending = state.pending;
			// Re-validate the binding: a plan that went stale, invalid, gone, or
			// whose version drifted since review must not be applied out of date.
			const blocked = submissionBlockReason(pending, action.live);
			if (blocked) {
				return {
					state: { phase: "idle", pending: null, blockedReason: blocked },
					effect: { type: "blocked", reason: blocked },
				};
			}
			return {
				state: { phase: "submitting", pending, blockedReason: null },
				effect: { type: "submit", snapshot: pending.snapshot },
			};
		}
		case "cancel": {
			// Dismiss the risk gate; nothing was submitted.
			if (state.phase !== "confirming-acknowledgment") {
				return { state, effect: { type: "none" } };
			}
			return { state: initialApprovalState, effect: { type: "none" } };
		}
		case "settle": {
			// The in-flight submit finished; return to idle for the next approval.
			if (state.phase !== "submitting") {
				return { state, effect: { type: "none" } };
			}
			return { state: initialApprovalState, effect: { type: "none" } };
		}
		default:
			return assertNever(action);
	}
}

/**
 * The exact-counts mutation copy for the bound approval, derived from the SAME
 * trimmed snapshot the card showed and will apply. `null` when nothing is bound.
 */
export function approvalMutationCopy(
	pending: PendingApproval | null,
): string | null {
	return pending ? planApprovalCopy(pending.snapshot.folders) : null;
}

// ── React hook ───────────────────────────────────────────────────────────────

/** The orchestration surface the chat pane drives the approve flow through. */
export interface ApprovalOrchestration {
	/** Current phase, so the pane can render the acknowledgment gate. */
	readonly phase: ApprovalPhase;
	/** The bound approval (snapshot + risk) while confirming or submitting. */
	readonly pending: PendingApproval | null;
	/** True while a submit is in flight; the pane blocks other actions. */
	readonly isSubmitting: boolean;
	/** Approve handler for the plan card (matches `ApprovePlanHandler`). */
	readonly approve: (snapshot: PlanMessage) => void;
	/** Confirm the risk acknowledgment and proceed to submit. */
	readonly confirmAcknowledgment: () => void;
	/** Dismiss the risk acknowledgment without submitting. */
	readonly cancelAcknowledgment: () => void;
	/** Mark the in-flight submit settled (wired to the driver's completion). */
	readonly settle: () => void;
}

export interface UseApprovalOrchestrationOptions {
	/** The live transcript, so a binding can be re-validated at submit time. */
	readonly messages: readonly ChatMessage[];
	/** Runs the (mock) journaled apply for an approved, in-date snapshot. */
	readonly onSubmit: (snapshot: PlanMessage) => void;
	/** Optional: told why an approval was refused (defence-in-depth surfacing). */
	readonly onBlocked?: (reason: string) => void;
}

/**
 * The thin React wrapper around the pure machine. It owns the approval state,
 * keeps the latest transcript and callbacks reachable from event handlers
 * without stale closures, and drives every action through `reduceApproval` so a
 * rapid double-approve or a plan that goes stale mid-flow behaves exactly as the
 * unit-tested core says it should.
 */
export function useApprovalOrchestration(
	options: UseApprovalOrchestrationOptions,
): ApprovalOrchestration {
	const { messages, onSubmit, onBlocked } = options;
	const [state, setState] = useState<ApprovalState>(initialApprovalState);

	// The authoritative state, updated synchronously so two approvals fired in
	// the same tick can't both read a stale `idle` and both submit.
	const stateRef = useRef(state);
	stateRef.current = state;
	// Latest transcript + callbacks, so handlers never close over stale values.
	const messagesRef = useRef(messages);
	messagesRef.current = messages;
	const onSubmitRef = useRef(onSubmit);
	onSubmitRef.current = onSubmit;
	const onBlockedRef = useRef(onBlocked);
	onBlockedRef.current = onBlocked;

	const run = useCallback((action: ApprovalAction) => {
		const { state: next, effect } = reduceApproval(stateRef.current, action);
		stateRef.current = next;
		setState(next);
		if (effect.type === "submit") {
			onSubmitRef.current(effect.snapshot);
		} else if (effect.type === "blocked") {
			onBlockedRef.current?.(effect.reason);
		}
	}, []);

	// The current state of a bound plan, read fresh from the transcript.
	const liveBindingFor = useCallback((planId: string): LiveBinding => {
		const live = messagesRef.current.find(
			(message): message is PlanMessage =>
				message.kind === "plan" && message.id === planId,
		);
		if (!live) return { status: "gone", version: "" };
		return {
			status: live.status,
			version: planFingerprint(live),
			...(live.statusReason ? { statusReason: live.statusReason } : {}),
		};
	}, []);

	const approve = useCallback(
		(snapshot: PlanMessage) => {
			// Bind the version to the live source plan the card was rendered from, so
			// a later change to it (stale / regenerated) is detected even though the
			// snapshot we submit is the user's trimmed selection.
			const source = messagesRef.current.find(
				(message): message is PlanMessage =>
					message.kind === "plan" && message.id === snapshot.id,
			);
			const version = planFingerprint(source ?? snapshot);
			run({ type: "approve", snapshot, version });
		},
		[run],
	);

	const confirmAcknowledgment = useCallback(() => {
		const pending = stateRef.current.pending;
		if (!pending) return;
		run({ type: "acknowledge", live: liveBindingFor(pending.snapshot.id) });
	}, [run, liveBindingFor]);

	const cancelAcknowledgment = useCallback(
		() => run({ type: "cancel" }),
		[run],
	);
	const settle = useCallback(() => run({ type: "settle" }), [run]);

	return {
		phase: state.phase,
		pending: state.pending,
		isSubmitting: state.phase === "submitting",
		approve,
		confirmAcknowledgment,
		cancelAcknowledgment,
		settle,
	};
}
