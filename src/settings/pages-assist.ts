import { Bridge } from "../core/bridge";
import { h } from "../views/dom";
import { app, set } from "./ctx";
import { group, inline, pageHead, row, testButton, toggle } from "./ui";

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
    group({ title: "Écoute", icon: "mic", tone: "orange", note: "Le mot de réveil est reconnu sur ton PC par Windows, rien n'est enregistré. Pendant un appel ou en mode jeu, Tako n'écoute pas les commandes." },
      row({ icon: "mic", tone: "orange", title: "Réveil « Hey Tako »", desc: "Dis « Hey Tako », l'îlot s'ouvre et le personnage t'écoute. Tu peux aussi cliquer sur le micro dans l'îlot.", keywords: "jarvis voix micro parler hey ok salut",
        control: inline(listenNow, toggle(on, (v) => set("voiceEnabled", v, v ? "Tako t'écoute" : "Écoute coupée"))) }),
      row({ icon: "speaker", tone: "green", title: "Répondre à voix haute", desc: "Avec la voix française de Windows. Sinon la réponse s'affiche seulement.", keywords: "synthèse vocale parole lecture",
        control: toggle(c.settings.voiceReplies, (v) => set("voiceReplies", v)) }),
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
      h("p", { class: "group-note", text: "Ta question passe par la dictée de Windows, qui utilise la reconnaissance vocale en ligne de Microsoft : active-la dans Paramètres Windows › Confidentialité et sécurité › Voix si Tako te le demande." }),
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
