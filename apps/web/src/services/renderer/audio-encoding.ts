import {
	AudioBufferSource,
	EncodedAudioPacketSource,
	type EncodedPacket,
	Output,
	Mp4OutputFormat,
	WebMOutputFormat,
	BufferTarget,
	type AudioCodec,
	type Quality,
} from "mediabunny";

type Packet = { packet: EncodedPacket; meta?: EncodedAudioChunkMetadata };
const delays = new Map<string, Promise<number>>();

async function encode(
	audio: AudioBuffer,
	codec: AudioCodec,
	bitrate: number | Quality,
) {
	const packets: Packet[] = [];
	const source = new AudioBufferSource({
		codec,
		bitrate,
		onEncodedPacket: (packet, meta) => packets.push({ packet, meta }),
	});
	const output = new Output({
		format: codec === "opus" ? new WebMOutputFormat() : new Mp4OutputFormat(),
		target: new BufferTarget(),
	});
	output.addAudioTrack(source);
	await output.start();
	await source.add(audio);
	source.close();
	await output.finalize();
	return packets;
}

async function calibrate(
	sampleRate: number,
	channels: number,
	bitrate: number | Quality,
): Promise<number> {
	if (typeof AudioDecoder === "undefined") return 0;
	const impulse = new AudioBuffer({
		sampleRate,
		numberOfChannels: channels,
		length: Math.round(sampleRate * 0.5),
	});
	const expected = Math.round(sampleRate * 0.1);
	for (let i = 0; i < channels; i++) impulse.getChannelData(i)[expected] = 0.8;
	const packets = await encode(impulse, "aac", bitrate);
	const config = packets.find((value) => value.meta?.decoderConfig)?.meta
		?.decoderConfig;
	if (!config)
		throw new Error("AAC calibration decoder configuration unavailable");
	let peak = 0,
		position = 0;
	let failure: Error | null = null;
	const decoder = new AudioDecoder({
		output(data) {
			try {
				const samples = new Float32Array(data.numberOfFrames);
				data.copyTo(samples, { planeIndex: 0, format: "f32-planar" });
				for (let i = 0; i < samples.length; i++)
					if (Math.abs(samples[i]) > peak) {
						peak = Math.abs(samples[i]);
						position = data.timestamp / 1e6 + i / data.sampleRate;
					}
			} finally {
				data.close();
			}
		},
		error(error) {
			failure = error;
		},
	});
	try {
		decoder.configure(config);
		for (const { packet } of packets)
			decoder.decode(packet.toEncodedAudioChunk());
		await decoder.flush();
		if (failure) throw failure;
		const delay = position - expected / sampleRate;
		if (!peak || delay < -0.005 || delay > 0.1)
			throw new Error("AAC calibration returned an invalid delay");
		return Math.max(0, delay);
	} finally {
		if (decoder.state !== "closed") decoder.close();
	}
}

export async function prepareAudio(
	audio: AudioBuffer,
	codec: AudioCodec,
	bitrate: number | Quality,
) {
	let delay = 0;
	if (codec === "aac") {
		const key = `${audio.sampleRate}:${audio.numberOfChannels}:${String(bitrate)}`;
		if (!delays.has(key))
			delays.set(
				key,
				calibrate(audio.sampleRate, audio.numberOfChannels, bitrate).catch(
					(error) => {
						console.warn(
							"AAC priming calibration unavailable; preserving encoder timestamps",
							error,
						);
						return 0;
					},
				),
			);
		delay = await delays.get(key)!;
	}
	const packets = await encode(audio, codec, bitrate);
	const source = new EncodedAudioPacketSource(codec);
	return {
		source,
		delay,
		async add() {
			let first = true;
			const configuration = packets.find(
				(value) => value.meta?.decoderConfig,
			)?.meta;
			for (const { packet, meta } of packets) {
				const shifted = packet.timestamp - delay;
				// The muxer cannot express a negative presentation timestamp. AAC's
				// leading priming packets precede the calibrated source clock.
				if (shifted < -0.000001) continue;
				const timestamp = Math.max(0, shifted);
				if (timestamp >= audio.duration) break;
				await source.add(
					packet.clone({
						timestamp,
						duration: Math.min(packet.duration, audio.duration - timestamp),
					}),
					first ? configuration : meta,
				);
				first = false;
			}
			source.close();
		},
	};
}
