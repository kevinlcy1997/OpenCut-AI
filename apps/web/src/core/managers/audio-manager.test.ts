import { afterEach, expect, spyOn, test } from "bun:test";
import { Input, type InputAudioTrack } from "mediabunny";
import { AudioManager } from "./audio-manager";
import type { EditorCore } from "@/core";
import type { AudioClipSource } from "@/lib/media/audio";
const restores: Array<() => void> = [];
afterEach(() => {
	for (const restore of restores.splice(0)) restore();
});
function fixture() {
	const editor = {
		playback: {
			getVolume: () => 1,
			getIsPlaying: () => true,
			subscribe: () => () => {},
		},
		timeline: {
			subscribe: () => () => {},
			getTracks: () => [],
			getTotalDuration: () => 1,
		},
		media: { subscribe: () => () => {}, getAssets: () => [] },
	} as unknown as EditorCore;
	const manager = new AudioManager(editor);
	const access = manager as unknown as {
		getAudioSink(options: { clip: AudioClipSource }): Promise<unknown>;
		disposeSinks(): void;
		inputs: Map<string, Input>;
		sinks: Map<string, unknown>;
	};
	const clip = {
		sourceKey: "original",
		file: new File(["fixture"], "test.wav"),
	} as AudioClipSource;
	restores.push(() => manager.dispose());
	return { manager, access, clip };
}
function deferred() {
	let resolve!: (value: InputAudioTrack | null) => void;
	const promise = new Promise<InputAudioTrack | null>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

test("split clips share one in-flight audio input and empty tracks release it", async () => {
	const f = fixture(),
		metadata = deferred();
	const opening = spyOn(
		Input.prototype,
		"getPrimaryAudioTrack",
	).mockReturnValue(metadata.promise);
	restores.push(() => opening.mockRestore());
	const first = f.access.getAudioSink({ clip: f.clip });
	const second = f.access.getAudioSink({
		clip: { ...f.clip, id: "split-right" },
	});
	expect(first).toBe(second);
	expect(opening).toHaveBeenCalledTimes(1);
	expect(f.access.inputs.size).toBe(1);
	metadata.resolve(null);
	await first;
	expect(f.access.inputs.size).toBe(0);
});

test("a project switch disposes pending input and stale completion cannot replace the new one", async () => {
	const f = fixture(),
		old = deferred(),
		current = deferred();
	let calls = 0;
	const opening = spyOn(
		Input.prototype,
		"getPrimaryAudioTrack",
	).mockImplementation(() => (++calls === 1 ? old.promise : current.promise));
	const disposing = spyOn(Input.prototype, "dispose");
	restores.push(
		() => opening.mockRestore(),
		() => disposing.mockRestore(),
	);
	const first = f.access.getAudioSink({ clip: f.clip });
	f.access.disposeSinks();
	expect(disposing).toHaveBeenCalled();
	const second = f.access.getAudioSink({ clip: f.clip });
	const currentInput = f.access.inputs.get("original");
	old.resolve({} as InputAudioTrack);
	await first;
	expect(f.access.inputs.get("original")).toBe(currentInput);
	expect(f.access.getAudioSink({ clip: f.clip })).toBe(second);
	current.resolve(null);
	await second;
	expect(f.access.inputs.size).toBe(0);
	expect(f.access.sinks.size).toBe(0);
});

test("metadata failure releases the input and permits a later retry", async () => {
	const f = fixture();
	const opening = spyOn(
		Input.prototype,
		"getPrimaryAudioTrack",
	).mockRejectedValue(new Error("bad audio"));
	restores.push(() => opening.mockRestore());
	await f.access.getAudioSink({ clip: f.clip });
	expect(f.access.inputs.size).toBe(0);
	opening.mockResolvedValue(null);
	await f.access.getAudioSink({ clip: f.clip });
	expect(opening).toHaveBeenCalledTimes(2);
});

test("stopping playback invalidates old sessions and releases catch-up timers immediately", async () => {
	const f = fixture();
	const access = f.manager as unknown as {
		playbackSessionId: number;
		catchupWaiters: Set<() => void>;
		stopPlayback(): void;
		waitUntilCaughtUp(options: {
			timelineTime: number;
			targetAhead: number;
			sessionId: number;
		}): Promise<void>;
	};
	const session = access.playbackSessionId;
	const waiting = access.waitUntilCaughtUp({
		timelineTime: 9999,
		targetAhead: 1,
		sessionId: session,
	});
	expect(access.catchupWaiters.size).toBe(1);
	access.stopPlayback();
	await waiting;
	expect(access.catchupWaiters.size).toBe(0);
	expect(access.playbackSessionId).not.toBe(session);
	await access.waitUntilCaughtUp({
		timelineTime: 9999,
		targetAhead: 1,
		sessionId: session,
	});
	expect(access.catchupWaiters.size).toBe(0);
});

test("an older playback start cannot overwrite a newer seek after context resume", async () => {
	const f = fixture();
	const access = f.manager as unknown as {
		ensureAudioContext(): AudioContext | null;
		rebuildTrackNodes(): void;
		scheduleUpcomingClips(): void;
		startPlayback(options: { time: number }): Promise<void>;
		playbackStartTime: number;
	};
	let resumeOld!: () => void;
	const oldResume = new Promise<void>((resolve) => {
		resumeOld = resolve;
	});
	let resumes = 0;
	const context = {
		state: "suspended",
		currentTime: 1,
		resume: () => (++resumes === 1 ? oldResume : Promise.resolve()),
	} as unknown as AudioContext;
	const contextSpy = spyOn(access, "ensureAudioContext").mockReturnValue(
		context,
	);
	const rebuild = spyOn(access, "rebuildTrackNodes").mockImplementation(
		() => {},
	);
	const schedule = spyOn(access, "scheduleUpcomingClips").mockImplementation(
		() => {},
	);
	restores.push(
		() => contextSpy.mockRestore(),
		() => rebuild.mockRestore(),
		() => schedule.mockRestore(),
	);
	const oldStart = access.startPlayback({ time: 10 });
	await access.startPlayback({ time: 20 });
	expect(access.playbackStartTime).toBe(20);
	resumeOld();
	await oldStart;
	expect(access.playbackStartTime).toBe(20);
	expect(schedule).toHaveBeenCalledTimes(1);
});
