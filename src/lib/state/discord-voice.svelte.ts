import { analyser } from '$lib/audio/analyser';
import {
    DISCORD_VOICE_BUFFER_LIMIT, DISCORD_VOICE_PATH, DISCORD_VOICE_PORT, voiceProof,
} from '$lib/discord-voice-relay';
import { isAndroid } from '$lib/platform';
import type { DiscordVoiceStream } from '$lib/wayship-discord';

const MIME = 'audio/webm;codecs=opus';

interface Capture {
    socket: WebSocket;
    audio?: ReturnType<typeof analyser.captureOutput>;
    recorder?: MediaRecorder;
}

class DiscordVoice {
    room = $state('');
    private capture: Capture | undefined;

    get available() {
        return !isAndroid && typeof MediaRecorder !== 'undefined' &&
            MediaRecorder.isTypeSupported(MIME) && analyser.canCapture;
    }

    async start({ key, relayId, room }: DiscordVoiceStream, isCurrent: () => boolean) {
        if (!this.available) throw new Error('Open the desktop Zeta music player first.');
        if (this.capture) throw new Error('Zeta is already sharing audio to Discord.');
        const socket = new WebSocket(`ws://127.0.0.1:${DISCORD_VOICE_PORT}${DISCORD_VOICE_PATH}${relayId}`);
        const capture: Capture = { socket };
        this.capture = capture;

        await new Promise<void>((resolve, reject) => {
            let phase: 'challenge' | 'checking' | 'start' | 'streaming' = 'challenge';
            const fail = (error: Error) => {
                clearTimeout(timer);
                if (this.capture === capture) this.stop();
                reject(error);
            };
            const timer = setTimeout(() => fail(new Error('Zeta could not reach the Discord bot on this computer.')), 5000);
            socket.onclose = socket.onerror = () => fail(new Error('The Discord audio connection closed.'));
            socket.onmessage = async (event) => {
                try {
                    if (this.capture !== capture || !isCurrent()) throw new Error('The voice request expired.');
                    if (phase === 'challenge') {
                        phase = 'checking';
                        const { challenge, proof } = JSON.parse(String(event.data));
                        if (typeof challenge !== 'string' || !/^[\da-f]{32}$/.test(challenge) ||
                            proof !== await voiceProof(key, relayId, challenge, 'bot')) {
                            throw new Error('Could not verify the local Discord audio connection.');
                        }
                        const response = await voiceProof(key, relayId, challenge, 'app');
                        if (!isCurrent() || this.capture !== capture) throw new Error('The voice request expired.');
                        phase = 'start';
                        socket.send(response);
                        return;
                    }
                    if (phase !== 'start' || event.data !== 'ready') throw new Error('The Discord bot did not accept the audio connection.');
                    capture.audio = analyser.captureOutput();
                    const recorder = new MediaRecorder(capture.audio.stream, { mimeType: MIME, audioBitsPerSecond: 128_000 });
                    capture.recorder = recorder;
                    recorder.ondataavailable = ({ data }) => {
                        if (this.capture !== capture || !data.size || socket.readyState !== WebSocket.OPEN) return;
                        if (socket.bufferedAmount + data.size > DISCORD_VOICE_BUFFER_LIMIT) {
                            this.stop();
                            return;
                        }
                        socket.send(data);
                    };
                    recorder.onerror = () => fail(new Error('Zeta could not encode the Discord audio.'));
                    recorder.start(160);
                    phase = 'streaming';
                    socket.onmessage = null;
                    this.room = room;
                    clearTimeout(timer);
                    resolve();
                } catch (error) {
                    fail(error instanceof Error ? error : new Error('Could not start Discord audio.'));
                }
            };
        });
    }

    stop() {
        const capture = this.capture;
        this.capture = undefined;
        this.room = '';
        if (!capture) return;
        if (capture.recorder && capture.recorder.state !== 'inactive') capture.recorder.stop();
        capture.audio?.stop();
        capture.socket.close();
    }
}

export const discordVoice = new DiscordVoice();
