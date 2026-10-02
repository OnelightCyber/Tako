import { Bridge } from "../core/bridge";
import { h, clear } from "../views/dom";
import { proIcon } from "../views/pro-icons";
import { weatherIcon, weatherLabel } from "../views/weather";
import { temp } from "../core/hud";
import { app, save, set } from "./ctx";
import { dropdown } from "./dropdown";
import { button, field, group, inline, pageHead, row, testButton, toggle, whenShown } from "./ui";

function withTest(control: HTMLElement, kind: string): HTMLElement {
  return inline(testButton(() => void Bridge.hudTest(kind)), control);
}

function minutes(values: number[]) {
  return values.map((m) => ({ value: String(m), label: `${m} min` }));
}

export function livePage(): Node[] {
  const c = app.ctx;
  const pick = (values: number[], current: number, key: "pomodoroFocus" | "pomodoroBreak" | "pomodoroLong") =>
    dropdown(minutes(values), String(current), (v) => set(key, Number(v)));
  return [
    pageHead("layers", "green", "Activités en direct", "Ce qui reste affiché en haut tant que ça dure, comme les Live Activities de l'iPhone."),
    group({ title: "Îlot", icon: "layers", tone: "green" },
      row({ icon: "eye", tone: "green", title: "Garder l'îlot visible pendant une activité", desc: "Claude qui travaille, une musique, un appel, un minuteur ou un téléchargement : l'îlot replié reste affiché. Sinon il se cache après une minute.", keywords: "toujours afficher replié",
        control: toggle(c.settings.keepLiveVisible, (v) => set("keepLiveVisible", v)) }),
    ),
    group({ title: "Musique", icon: "music", tone: "pink" },
      row({ icon: "music", tone: "pink", title: "Musique en cours", desc: "Spotify, YouTube, Deezer… la pochette dans l'îlot replié, les boutons lecture / suivant quand il est ouvert.", keywords: "spotify media",
        control: toggle(c.settings.mediaEnabled, (v) => set("mediaEnabled", v)) }),
      row({ icon: "volume", tone: "pink", title: "Visualiseur audio", desc: "Les barres dansent sur le vrai son de ton PC, pas sur une animation.", keywords: "égaliseur barres",
        control: toggle(c.settings.visualizer, (v) => set("visualizer", v)) }),
    ),
    group({ title: "Appels", icon: "phoneCall", tone: "green" },
      row({ icon: "phoneCall", tone: "green", title: "Appel en cours", desc: "Discord, Teams, Zoom, WhatsApp… Dès qu'une appli d'appel utilise ton micro, l'îlot affiche le temps d'appel.", keywords: "discord teams zoom micro",
        control: withTest(toggle(c.settings.callActivity, (v) => set("callActivity", v)), "call") }),
    ),
    group({ title: "Téléchargements", icon: "download", tone: "cyan" },
      row({ icon: "download", tone: "cyan", title: "Suivre les téléchargements", desc: "Chrome, Edge, Opera, Firefox : la progression en direct, puis Ouvrir ou Dossier quand c'est fini. Les programmes ne sont jamais lancés, seulement montrés.", keywords: "fichier download",
        control: withTest(toggle(c.settings.downloadsEnabled, (v) => set("downloadsEnabled", v)), "download") }),
    ),
    group({ title: "Minuteur & Pomodoro", icon: "timer", tone: "orange", note: "Lance-le depuis l'onglet minuteur de l'îlot. Le temps reste affiché autour du personnage, et l'îlot se divise en deux quand une autre activité tourne." },
      row({ icon: "timer", tone: "orange", title: "Focus", keywords: "pomodoro minuteur", control: pick([15, 20, 25, 30, 45, 50, 60, 90], c.settings.pomodoroFocus, "pomodoroFocus") }),
      row({ icon: "clock", tone: "green", title: "Pause", control: pick([3, 5, 10, 15], c.settings.pomodoroBreak, "pomodoroBreak") }),
      row({ icon: "clock", tone: "cyan", title: "Grande pause", control: pick([10, 15, 20, 30], c.settings.pomodoroLong, "pomodoroLong") }),
      row({ icon: "layers", tone: "purple", title: "Grande pause après", control: dropdown([2, 3, 4, 5, 6].map((n) => ({ value: String(n), label: `${n} focus` })), String(c.settings.pomodoroRounds), (v) => set("pomodoroRounds", Number(v))) }),
    ),
  ];
}

export function notificationsPage(): Node[] {
  const c = app.ctx;
  const muted = h("div", { class: "muted-list" });
  const drawMuted = () => {
    clear(muted);
    if (!c.settings.notificationsMuted.length) {
      muted.append(h("p", { class: "group-note", text: "Aucune appli masquée. Dans le centre de notifications de l'îlot, survole une notification et clique sur la cloche barrée pour ne plus voir une appli." }));
      return;
    }
    for (const id of c.settings.notificationsMuted) {
      const restore = button("Réafficher", "ghost", () => {
        c.settings.notificationsMuted = c.settings.notificationsMuted.filter((x) => x !== id);
        drawMuted();
        void save("Appli réaffichée");
      });
      restore.classList.add("small");
      muted.append(h("div", { class: "muted-item" }, proIcon("bellOff", 14, 2), h("code", { text: id }), restore));
    }
  };
  drawMuted();
  return [
    pageHead("bell", "red", "Notifications", "Les notifications de Windows, en haut de l'écran."),
    group({ title: "Dans l'îlot", icon: "bell", tone: "red", note: "Tako lit les notifications que Windows reçoit (Discord, WhatsApp, Outlook, Teams…) et les affiche avec l'icône de l'appli. Un clic ouvre l'appli. Rien ne quitte ton PC." },
      row({ icon: "bell", tone: "red", title: "Afficher les notifications", desc: "Une bannière dans l'îlot, et le centre de notifications dans l'onglet cloche.", keywords: "discord whatsapp outlook toast",
        control: withTest(toggle(c.settings.notificationsEnabled, (v) => set("notificationsEnabled", v)), "notification") }),
      row({ icon: "eye", tone: "gray", title: "Masquer le contenu", desc: "Seulement l'appli et l'expéditeur, jamais le texte du message. Pratique quand tu partages ton écran.", keywords: "privé confidentialité stream",
        control: toggle(c.settings.notificationsPrivate, (v) => set("notificationsPrivate", v)) }),
    ),
    group({ title: "Applis masquées", icon: "bellOff", tone: "gray" }, muted),
    group({ title: "Bon à savoir", icon: "info", tone: "blue" },
      h("p", { class: "group-note", text: "Windows transmet les notifications aux applis comme Tako avec quelques secondes de retard : la bannière de l'îlot arrive juste après celle de Windows, et une notification trop ancienne va directement dans le centre (onglet cloche)." }),
      h("p", { class: "group-note", text: "Windows affiche aussi ses propres bannières en bas à droite. Pour ne garder que celles de l'îlot, coupe les bannières appli par appli dans Paramètres Windows › Système › Notifications (garde les notifications activées, désactive seulement « Afficher les bannières »)." }),
    ),
  ];
}

export function systemPage(): Node[] {
  const c = app.ctx;
  const weatherState = h("div", { class: "wx-state" });
  const drawWeather = async () => {
    clear(weatherState);
    const w = await Bridge.weatherNow();
    const failed = w ? null : await Bridge.weatherFailure();
    if (w) {
      weatherState.append(proIcon(weatherIcon(w), 18, 2), h("b", { text: temp(w.temp) }), h("span", { text: `${weatherLabel(w.code)} · ${w.city} · ${temp(w.min)} / ${temp(w.max)}` }));
    } else if (!c.settings.weatherCity) {
      weatherState.append(h("span", { class: "muted small", text: "Choisis une ville pour voir la météo dans l'accueil de l'îlot." }));
    } else if (failed === "missing") {
      weatherState.append(h("span", { class: "muted small", text: `Ville introuvable : « ${c.settings.weatherCity} ». Essaie avec son nom complet.` }));
    } else if (failed === "offline") {
      weatherState.append(h("span", { class: "muted small", text: "Open-Meteo ne répond pas pour l'instant. Tako réessaiera tout seul." }));
    } else {
      weatherState.append(h("span", { class: "muted small", text: "Recherche de la météo…" }));
      window.setTimeout(() => {
        if (weatherState.isConnected) void drawWeather();
      }, 2500);
    }
  };
  whenShown(weatherState, () => void drawWeather());
  const city = field({
    value: c.settings.weatherCity, placeholder: "Paris, Lyon, Montréal…", button: "OK",
    onSubmit: (v) => {
      c.settings.weatherCity = v;
      void save(v ? `Météo : ${v}` : "Météo retirée").then(() => window.setTimeout(() => void drawWeather(), 2500));
    },
  });
  return [
    pageHead("cpu", "cyan", "Système", "Ce que fait ton PC, montré par l'îlot au bon moment."),
    group({ title: "Retours visuels", icon: "sparkles", tone: "cyan", note: "Comme sur iPhone : l'îlot s'étire une seconde pour te montrer ce qui vient de changer, puis se replie." },
      row({ icon: "volume", tone: "blue", title: "Volume", desc: "Quand tu montes, baisses ou coupes le son.", keywords: "son hud",
        control: withTest(toggle(c.settings.volumeHud, (v) => set("volumeHud", v)), "volume") }),
      row({ icon: "lock", tone: "green", title: "Verr. Maj", desc: "Quand tu actives ou désactives les majuscules.", keywords: "caps lock majuscules",
        control: withTest(toggle(c.settings.lockKeysHud, (v) => set("lockKeysHud", v)), "caps") }),
      row({ icon: "usb", tone: "cyan", title: "Clés USB et disques", desc: "Le nom, la place libre et un bouton Ouvrir quand tu branches une clé.", keywords: "usb disque externe",
        control: withTest(toggle(c.settings.drivesEnabled, (v) => set("drivesEnabled", v)), "drive") }),
    ),
    group({ title: "Batterie", icon: "battery", tone: "green", note: "Sur un PC fixe sans batterie, rien ne s'affiche." },
      row({ icon: "batteryCharge", tone: "green", title: "Charge et batterie faible", desc: "Quand tu branches le chargeur, quand tu passes sur batterie, et à 20 % puis 10 %.", keywords: "laptop portable chargeur",
        control: withTest(toggle(c.settings.batteryAlerts, (v) => set("batteryAlerts", v)), "charging") }),
    ),
    group({ title: "Confidentialité", icon: "mic", tone: "amber" },
      row({ icon: "mic", tone: "amber", title: "Points micro et caméra", desc: "Un point orange quand une appli utilise ton micro, vert pour la caméra. Survole-le pour savoir laquelle.", keywords: "privacy webcam",
        control: toggle(c.settings.privacyDots, (v) => set("privacyDots", v)) }),
    ),
    group({ title: "Météo", icon: "cloudSun", tone: "amber", note: "Affichée dans l'accueil de l'îlot. Seul le nom de la ville part vers Open-Meteo, un service gratuit et sans compte." },
      row({ icon: "sun", tone: "amber", title: "Météo dans l'accueil", control: toggle(c.settings.weatherEnabled, (v) => set("weatherEnabled", v)) }),
      row({ icon: "globe", tone: "blue", title: "Ville", keywords: "météo ville", wide: true, control: city.el }),
      weatherState,
    ),
  ];
}

export function networkPage(): Node[] {
  const c = app.ctx;
  const vpnLine = h("span", { class: "muted small", text: "Recherche d'un VPN…" });
  whenShown(vpnLine, () => {
    void Bridge.vpnStatus().then((s) => {
      if (!s) {
        vpnLine.textContent = "Disponible dans l'app Tako.";
        return;
      }
      vpnLine.textContent = !s.present ? "Aucun VPN détecté sur ce PC." : s.up ? `${s.name} connecté${s.location ? ` · ${s.location}` : ""}` : `${s.name} déconnecté`;
    });
  });
  return [
    pageHead("shield", "indigo", "Réseau & sécurité", "Internet, VPN et appareils Bluetooth."),
    group({ title: "Internet", icon: "wifi", tone: "blue" },
      row({ icon: "wifiOff", tone: "red", title: "Connexion perdue / rétablie", desc: "Tu sais tout de suite quand Internet tombe, et quand il revient.", keywords: "wifi réseau",
        control: withTest(toggle(c.settings.networkAlerts, (v) => set("networkAlerts", v)), "network") }),
    ),
    group({ title: "VPN", icon: "shieldCheck", tone: "indigo", note: "Mullvad, WireGuard, NordVPN, Proton… si le tunnel tombe, une alerte rouge te prévient que ton IP réelle est visible." },
      row({ icon: "shieldOff", tone: "indigo", title: "Alerte si le VPN se coupe", keywords: "mullvad wireguard",
        control: inline(testButton(() => void Bridge.vpnTest()), toggle(c.settings.vpnAlerts, (v) => set("vpnAlerts", v))) }),
      h("div", { class: "status-line" }, proIcon("shield", 13, 2), vpnLine),
    ),
    group({ title: "Bluetooth", icon: "bluetooth", tone: "blue" },
      row({ icon: "headphones", tone: "blue", title: "Animation à la connexion d'un casque", desc: "Le nom, l'icône et la batterie, comme sur iPhone.", keywords: "airpods écouteurs bluetooth",
        control: inline(testButton(() => void Bridge.bluetoothTest()), toggle(c.settings.btAnimation, (v) => set("btAnimation", v))) }),
    ),
  ];
}

export function gamePage(): Node[] {
  const c = app.ctx;
  const status = h("span", { class: "muted small", text: "Aucun jeu en plein écran." });
  whenShown(status, () => {
    void Bridge.gameStatus().then((g) => {
      if (g?.active) status.textContent = `Actif : ${g.app || "plein écran"}`;
    });
  });
  return [
    pageHead("gamepad", "pink", "Mode jeu", "Rien ne te dérange quand tu joues."),
    group({ title: "Plein écran", icon: "gameMode", tone: "pink", note: "Quand un jeu ou une vidéo est en plein écran, rien ne s'ouvre : l'îlot et le widget se cachent, les clics passent au jeu. À la sortie, Tako te dit ce que tu as raté." },
      row({ icon: "gameMode", tone: "pink", title: "Mode jeu automatique", control: toggle(c.settings.gameMode, (v) => set("gameMode", v, v ? "Mode jeu activé" : "Mode jeu désactivé")) }),
      row({ icon: "volumeOff", tone: "gray", title: "Couper les sons de Tako en jeu", desc: "Le minuteur sonne quand même.", control: toggle(c.settings.gameMute, (v) => set("gameMute", v)) }),
      h("div", { class: "status-line" }, proIcon("gamepad", 13, 2), status),
    ),
  ];
}

