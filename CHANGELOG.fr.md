# Historique des versions

[English](CHANGELOG.md) · **Français**

Toutes les versions de Tako, de la plus récente à la plus ancienne. Les installateurs sont sur la page
[Releases](https://github.com/OnelightCyber/Tako/releases), et une copie déjà installée se met à jour toute seule.

## 0.5.0 — 3 octobre 2026

La plus grosse mise à jour : l'îlot devient une vraie Dynamic Island, Tako t'écoute et te répond, et plusieurs
Claude travaillent pour toi en même temps, même la nuit.

### Une vraie Dynamic Island

- **L'îlot s'étire comme sur iPhone** : volume, Verr. Maj, charge et batterie faible, clé USB branchée (avec
  « Ouvrir »), connexion perdue puis rétablie, téléchargement en cours puis terminé (Ouvrir / Dossier).
- **Tes notifications Windows** (Discord, WhatsApp, Outlook, Teams…) arrivent dans l'îlot avec l'icône de l'appli,
  et l'onglet cloche les garde toutes. Masque une appli en un clic, ou cache le texte avec le mode privé.
- **Appels** : quand Discord, Teams ou Zoom utilisent ton micro, l'îlot affiche la durée de l'appel. Un point orange
  pour le micro, vert pour la caméra, avec le nom de l'appli au survol.
- **Aujourd'hui** : l'heure, la date et la météo, le mois en entier et les prévisions sur 5 jours.
- **Les deux côtés de l'îlot replié** : la date et la météo (ou ce que fait Claude) à gauche, l'heure ou tes
  notifications à droite.
- **L'accueil se remplit** : météo, utilisation de Claude, assistant vocal, date et minuteur en pastilles.
- **Le visualiseur suit le vrai son de ton PC**, aux couleurs de la pochette.
- **Trois tailles d'îlot** pour les grands écrans.
- **Mode jeu** : un terminal ou un éditeur en plein écran ne compte plus comme un jeu.

### Tako en mode Jarvis

- **« Hey Tako »** : l'îlot s'ouvre, le personnage t'écoute, tes mots s'affichent pendant que tu parles, et Claude
  répond avec ton propre compte Claude Code. « Tako, stop » coupe la parole.
- **Ta voix reste sur ton PC** : Whisper transcrit en local, en une demi-seconde environ (modèle de 190 Mo
  téléchargé une fois, SHA-256 vérifié).
- **Des voix naturelles** : Siwis, Pierre ou Jessica (Piper, en local). La voix de Windows reste disponible.
- **Réponses instantanées, sans Claude** : l'heure, la date, la météo, les minuteurs (« 10 minutes », « 1h30 »,
  « une heure et demie »), pause et musique suivante, tes notifications, les réglages.
- **Permissions à la voix** (en option) : « Tako, oui » autorise, « Tako, non » refuse. Un « oui » ne compte que si
  Tako est sûr de l'avoir entendu.
- La musique se met en pause pendant que Tako écoute ou parle, puis reprend. Rien pendant un appel ou en jeu.

### La Lentille

- Copie quelque chose et l'îlot propose quoi en faire : une **erreur** → Expliquer ou Réparer (une mission prête à
  lancer), un **texte en anglais** → Traduire, un **numéro de colis** → Suivre, une **adresse** → Itinéraire.
- Le texte est lu sur ton PC seulement pour le reconnaître, rien ne part sans clic, et les copies depuis un
  gestionnaire de mots de passe sont ignorées.

### Mission Control

- **Plusieurs Claude en même temps** (jusqu'à 4), chacun dans sa propre copie du projet (un worktree git) : ton
  dossier ne bouge pas tant que tu n'as pas fusionné.
- **Relire puis fusionner** : diff et lignes changées, **Fusionner** en un clic (Tako vérifie ta branche et
  annule tout en cas de conflit), **Jeter** avec confirmation, **Répondre** ou **Continuer** dans un terminal.
- **Garde-fous** : pas de mission sur une HEAD détachée ou pendant une fusion ou un rebase, une copie abîmée n'est
  jamais touchée, et chaque échec de fusion est expliqué.

### L'équipe de nuit

- Choisis « Cette nuit » : dès l'heure choisie (1 h par défaut) et jusqu'à 7 h, Claude enchaîne tes tâches. Le PC
  reste éveillé dès qu'une tâche est prévue.
- **Prudent** (modifications dans la copie du projet, tests et builds, tout le reste refusé) ou **mode auto** de
  Claude.
- **Le briefing du matin** : à ton retour, l'îlot ouvre le rapport de la nuit et Tako te le lit.

### Un personnage qui vit sa vie

- Il **danse sur ta musique**, **transpire** quand le processeur est à fond, **s'endort la nuit** et **fait la fête
  quand tes tests passent**.

### Des animations comme sur iPhone

- Effet gelée, **appui long** pour ouvrir l'activité en cours, **Maj + molette** (ou glissement sur le pavé tactile)
  pour passer d'une activité à l'autre, transitions avec flou, et un réglage « Réduire les animations ».

### Réglages

- Refaits de zéro : une page par module, un bouton « Tester » partout et une recherche. Nouvelles pages Assistant
  vocal, Mission Control et Lentille.

### Sous le capot

- Chrome ne démarre que quand l'agent navigateur sert vraiment.
- Plus léger sur les écrans 144 / 165 Hz : 60 images par seconde au maximum (120 quand l'îlot bouge, 30 au repos)
  et les vues cachées ne tournent plus.
- Téléchargements des modèles vérifiés, épinglés sur une version fixe, et abandonnés s'ils bloquent.
- Avant la sortie : une revue de code complète, et 528 tests d'interface tous au vert.

## 0.4.0 — 1er octobre 2026

- **L'îlot se divise en deux** : quand deux choses tournent en même temps, une bulle se détache comme une goutte,
  avec une animation gluante. Un clic l'ouvre.
- **Minuteur et Pomodoro** : cycles focus / pause / grande pause, un anneau autour du personnage, une alarme
  animée, et l'îlot reste visible tant qu'il tourne.
- **Mode jeu** : rien ne s'ouvre par-dessus un jeu ou une vidéo en plein écran, l'îlot et le widget se cachent et
  laissent passer les clics, les sons se coupent, et un récapitulatif t'attend après.
- **Bluetooth** : un casque qui se connecte s'affiche avec sa batterie.
- **Surveillance du VPN** : une alerte quand le tunnel tombe, une autre quand il revient, avec le lieu Mullvad.
- Le chat peut **ouvrir tes applis** à la demande, et ne les ferme jamais.
- L'agent navigateur garde **sa fenêtre Chrome ouverte** entre les messages.
- Le mode relecture laisse passer les sessions en mode auto, accept-edits ou bypass, et la vue live affiche le mode.
- Les missions et les Claude lancés par Tako n'héritent plus de l'environnement de la session d'origine.
- Les protections de la 0.3.0 sont de retour : fichiers sensibles jamais copiés ni envoyés, taille des copies
  plafonnée par tour, mode relecture qui refuse quand Tako est en pause ou débordé.

## 0.3.0 — 1er octobre 2026

- **Toutes tes sessions en même temps** : une pastille par terminal Claude Code (rouge quand elle t'attend, verte
  quand elle a fini), un anneau de contexte, et une file pour les demandes de permission.
- **Résumé de fin de tour** : fichiers, lignes ajoutées et retirées, durée et tokens, avec **Commit** (message écrit
  par Claude), **Voir le diff** et **Annuler** grâce à une copie prise avant chaque modification (gardée 3 jours,
  fichiers sensibles jamais copiés).
- **Mode relecture** (en option) : chaque modification attend ton OK dans l'îlot, avec le vrai diff. Sans réponse,
  rien n'est modifié.
- **Missions** : un raccourci global lance Claude Code sur un projet dans un nouveau terminal.
- **Utilisation** : alertes à 80 et 90 % avec une prévision, un son quand la limite de 5 h se recharge, et un
  historique dans les réglages.
- **Musique en cours** avec pochette et contrôles, et le processeur, la mémoire et la carte graphique en direct.
- Correctifs : le défilement des étapes ne se chevauche plus et ne bloque plus à 20 étapes, les nouvelles demandes
  sont protégées contre le clic trop rapide, et rien ne tourne quand l'îlot est caché.

## 0.2.0 — 1er octobre 2026

- **Widget d'utilisation** : tes limites de 5 h et de la semaine en haut de l'écran, le détail au survol, à
  déplacer n'importe où avec aimantation, clic droit pour le masquer.
- **/usage** dans le chat affiche tes limites sous forme de jauges.
- Les réponses du chat se sélectionnent et se copient en un clic.
- Réglages : menus déroulants refaits et choix de la position du widget.
- Corrections : le chat n'attend plus l'agent navigateur, le bouton Demander marche après un dépôt de fichier, et
  les étapes affichent la description de la commande.

## 0.1.1 — 1er octobre 2026 — Première version

- **La vue live de Claude Code** : chaque outil comme une étape, le diff de chaque modification avec ses vrais
  numéros de ligne, le fichier lu, la commande et la fin de sa sortie, le plan de tâches. L'îlot grandit avec ce
  qu'il montre.
- **Les permissions en un clic** depuis l'îlot.
- **Un chat avec ton propre compte Claude Code** (sans clé API), qui voit ton écran, connaît les commandes `/` et
  peut piloter un navigateur, avec Autoriser / Refuser à chaque fois.
- Dépôt de fichiers, intégrations (GitHub, Vercel, n8n, Resend, Notion, Cal.com, Stripe), une fenêtre de réglages
  complète et des mises à jour automatiques signées.
