import { Bridge, onEvent, type SttProgress, type SttStatus, type TtsProgress, type TtsStatus } from "../core/bridge";
import { dropdown } from "./dropdown";
import { h, clear } from "../views/dom";
import { app, set } from "./ctx";
import { button, group, inline, pageHead, pill, row, testButton, toggle, whenShown } from "./ui";

let modelHost: HTMLElement | null = null;
let listening = false;

function drawModel(s: SttStatus | null, error: string | null = null) {
  const host = modelHost;
  if (!host || !host.isConnected) return;
  clear(host);
  if (!s) {
    host.append(pill("off", "Indisponible"));
    return;
  }
  if (s.installed) {
    host.append(pill("ok", "Prête"));
    return;
  }
  if (s.downloading) {
    const pct = s.total ? Math.min(100, Math.round((s.received / s.total) * 100)) : 0;
    host.append(h("div", { class: "stt-bar" }, h("i", { style: `width:${pct}%` })), h("span", { class: "stt-pct", text: `${pct} %` }));
    return;
  }
  if (error) host.append(h("span", { class: "muted small", text: error === "offline" ? "Pas de connexion" : "Échec, réessaie" }));
  host.append(button("Télécharger · 190 Mo", "primary", () => {
    void Bridge.sttDownload();
    window.setTimeout(refreshModel, 500);
  }, "download"));
}

function refreshModel() {
  void Bridge.sttStatus().then((s) => drawModel(s));
}

const VOICES = [
  { value: "siwis", label: "Siwis · féminine" },
  { value: "pierre", label: "Pierre · masculine" },
  { value: "jessica", label: "Jessica · féminine" },
  { value: "windows", label: "Voix de Windows" },
];
const SAMPLE = "Bonjour, je suis Tako. Je te lis les réponses de Claude, et je peux lancer un minuteur ou mettre ta musique en pause.";

let voiceHost: HTMLElement | null = null;
let voiceListening = false;
let sample: HTMLAudioElement | null = null;

function voiceSize(total: number): string {
  return `${Math.max(1, Math.round(total / 1_000_000))} Mo`;
}

function drawVoice(s: TtsStatus | null, error: string | null = null) {
  const host = voiceHost;
  if (!host || !host.isConnected) return;
  clear(host);
  const name = app.ctx.settings.voiceName;
  const listen = button("Écouter", "ghost", () => {
    listen.disabled = true;
    void Bridge.voiceSay(SAMPLE).then((url) => {
      sample?.pause();
      sample = new Audio(url);
      void sample.play();
    }).catch(() => undefined).finally(() => {
      listen.disabled = false;
    });
  }, "play");
  listen.classList.add("small");
  if (name === "windows" || !s || s.ready) {
    host.append(listen);
    return;
  }
  if (s.downloading) {
    const pct = s.total ? Math.min(100, Math.round((s.received / s.total) * 100)) : 0;
    host.append(h("div", { class: "stt-bar" }, h("i", { style: `width:${pct}%` })), h("span", { class: "stt-pct", text: `${pct} %` }));
    return;
  }
  if (error) host.append(h("span", { class: "muted small", text: error === "offline" ? "Pas de connexion" : "Échec, réessaie" }));
  host.append(button(`Télécharger · ${voiceSize(s.total)}`, "primary", () => {
    void Bridge.ttsDownload(name);
    window.setTimeout(refreshVoice, 500);
  }, "download"));
}

function refreshVoice() {
  const name = app.ctx.settings.voiceName;
  if (name === "windows") {
    drawVoice(null);
    return;
  }
  void Bridge.ttsStatus(name).then((s) => drawVoice(s));
}

function voiceControl(): HTMLElement {
  voiceHost = h("div", { class: "stt-state" });
  whenShown(voiceHost, refreshVoice);
  if (!voiceListening) {
    voiceListening = true;
    void onEvent<TtsProgress>("tts-progress", (p) => {
      if (p.voice !== app.ctx.settings.voiceName) return;
      if (p.done) {
        if (p.error) drawVoice({ ready: false, downloading: false, received: 0, total: p.total }, p.error);
        else refreshVoice();
        return;
      }
      drawVoice({ ready: false, downloading: true, received: p.received, total: p.total });
    });
  }
  return inline(dropdown(VOICES, app.ctx.settings.voiceName, (v) => {
    set("voiceName", v, "Voix changée");
    if (v !== "windows" && app.ctx.settings.voiceEnabled) void Bridge.ttsDownload(v);
    window.setTimeout(refreshVoice, 400);
  }), voiceHost);
}

function modelControl(): HTMLElement {
  modelHost = h("div", { class: "stt-state" });
  whenShown(modelHost, refreshModel);
  if (!listening) {
    listening = true;
    void onEvent<SttProgress>("stt-progress", (p) => {
      if (p.done) {
        if (p.error) drawModel({ installed: false, downloading: false, received: 0, total: p.total }, p.error);
        else refreshModel();
        return;
      }
      drawModel({ installed: false, downloading: true, received: p.received, total: p.total });
    });
  }
  return modelHost;
}

function tryIt(kind: string): HTMLElement {
  return testButton(() => void Bridge.hudTest(kind));
}

function say(phrase: string, what: string): HTMLElement {
  return h("div", { class: "key" }, h("kbd", { text: phrase }), h("span", { text: what }));
}

export function voicePage(): Node[] {
  const c = app.ctx;
  const on = c.settings.voiceEnabled;
  const listenNow = testButton(() => void Bridge.hudTest("voice"), "Essayer");
  listenNow.disabled = !on;
  return [
    pageHead("mic", "orange", "Assistant vocal", "Tako en mode Jarvis : tu lui parles, Claude te répond à voix haute."),
    group({ title: "Écoute", icon: "mic", tone: "orange", note: "Tout se passe sur ton PC : Windows guette « Hey Tako », puis Whisper transcrit ta question. Ta voix ne quitte jamais l'ordinateur, seule ta question écrite part vers Claude. Pendant un appel ou en mode jeu, Tako n'écoute pas les commandes." },
      row({ icon: "mic", tone: "orange", title: "Réveil « Hey Tako »", desc: "Dis « Hey Tako », l'îlot s'ouvre et le personnage t'écoute. Tu peux aussi cliquer sur le micro dans l'îlot.", keywords: "jarvis voix micro parler hey ok salut",
        control: inline(listenNow, toggle(on, (v) => set("voiceEnabled", v, v ? "Tako t'écoute" : "Écoute coupée"))) }),
      row({ icon: "sparkles", tone: "purple", title: "Reconnaissance vocale", desc: "Whisper, en local et en français. Le modèle (190 Mo) se télécharge une seule fois, quand tu actives l'écoute.", keywords: "whisper modèle dictée transcription hors ligne",
        control: modelControl() }),
      row({ icon: "speaker", tone: "green", title: "Répondre à voix haute", desc: "Sinon la réponse s'affiche seulement.", keywords: "synthèse vocale parole lecture",
        control: toggle(c.settings.voiceReplies, (v) => set("voiceReplies", v)) }),
      row({ icon: "music", tone: "pink", title: "Voix de Tako", desc: "Des voix naturelles (Piper) qui tournent sur ton PC, téléchargées une seule fois. La voix de Windows reste disponible, en plus robotique.", keywords: "voix naturelle piper siwis pierre jessica synthèse",
        control: voiceControl(), wide: true }),
      row({ icon: "shieldCheck", tone: "amber", title: "Valider les permissions à la voix", desc: "« Tako, oui » autorise et « Tako, non » refuse la demande affichée. Un « oui » n'est accepté que si Tako est sûr de l'avoir entendu.", keywords: "approbation autoriser refuser permission oui non",
        control: toggle(c.settings.voiceApprovals, (v) => set("voiceApprovals", v), !on) }),
    ),
    group({ title: "Ce que tu peux dire", icon: "message", tone: "blue" },
      h("div", { class: "keys" },
        say("Quelle heure est-il ?", "répond tout de suite, sans Claude"),
        say("Mets un minuteur de 10 minutes", "lance le minuteur de l'îlot"),
        say("Pause · Musique suivante", "contrôle la musique en cours"),
        say("Quel temps fait-il ?", "la météo de ta ville"),
        say("N'importe quelle question", "Claude Code y répond avec ton compte"),
        say("Tako, stop", "coupe la parole"),
      ),
    ),
    group({ title: "Bon à savoir", icon: "info", tone: "gray" },
      h("p", { class: "group-note", text: "Attends le petit bip après « Hey Tako », puis parle normalement : Tako s'arrête d'écouter dès que tu te tais." }),
      h("p", { class: "group-note", text: "Pendant que Tako t'écoute ou te répond, la musique se met en pause puis reprend toute seule." }),
    ),
  ];
}

export function lensPage(): Node[] {
  const c = app.ctx;
  return [
    pageHead("clipboard", "cyan", "Lentille", "Tako comprend ce que tu copies et te propose la bonne action."),
    group({ title: "Lentille", icon: "clipboard", tone: "cyan", note: "Le texte copié est lu sur ton PC, seulement pour le reconnaître. Rien n'est envoyé tant que tu ne cliques pas sur une action. Ce que tu copies depuis un gestionnaire de mots de passe (Bitwarden, 1Password, KeePass…) est ignoré." },
      row({ icon: "clipboard", tone: "cyan", title: "Activer la Lentille", desc: "Une petite bulle dans l'îlot quand ce que tu copies peut servir.", keywords: "presse-papiers copier coller",
        control: toggle(c.settings.lensEnabled, (v) => set("lensEnabled", v)) }),
    ),
    group({ title: "Ce que Tako reconnaît", icon: "sparkles", tone: "purple" },
      row({ icon: "wrench", tone: "red", title: "Une erreur", desc: "Expliquer avec Claude, ou Réparer : une mission Claude Code prête à lancer dans ton dernier projet.", keywords: "exception stack trace bug",
        control: tryIt("lens-error") }),
      row({ icon: "languages", tone: "blue", title: "Un texte en anglais", desc: "Le traduire en français avec Claude.", keywords: "traduction english",
        control: tryIt("lens-english") }),
      row({ icon: "package", tone: "amber", title: "Un numéro de colis", desc: "Suivre le colis : La Poste, Colissimo, UPS, DHL et les autres.", keywords: "suivi livraison tracking",
        control: tryIt("lens-tracking") }),
      row({ icon: "mapPin", tone: "green", title: "Une adresse", desc: "L'itinéraire ou la carte dans Google Maps.", keywords: "maps itinéraire plan",
        control: tryIt("lens-address") }),
    ),
  ];
}
