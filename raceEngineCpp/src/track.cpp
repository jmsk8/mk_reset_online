#include "track.hpp"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <dirent.h>
#include <fstream>
#include <sstream>
#include <sys/stat.h>

namespace track {

namespace {

[[noreturn]] void fail(const std::string& source, int line, const std::string& message) {
    const std::string where = line > 0
        ? source + ":" + std::to_string(line)
        : source;
    throw TrackError(where + " — " + message);
}

std::string rtrim(const std::string& s) {
    size_t end = s.size();
    while (end > 0 && (s[end - 1] == ' ' || s[end - 1] == '\r'
                       || s[end - 1] == '\t' || s[end - 1] == '\n')) {
        end--;
    }
    return s.substr(0, end);
}

std::string trim(const std::string& s) {
    size_t start = 0;
    while (start < s.size() && (s[start] == ' ' || s[start] == '\t')) start++;
    return rtrim(s.substr(start));
}

bool is_fence_open(const std::string& line) {
    const std::string t = trim(line);
    if (t.rfind("```", 0) != 0) return false;
    size_t i = 3;
    while (i < t.size() && t[i] == '`') i++;
    return trim(t.substr(i)) == "track";
}

bool is_fence_close(const std::string& line) {
    const std::string t = trim(line);
    if (t.rfind("```", 0) != 0) return false;
    size_t i = 3;
    while (i < t.size() && t[i] == '`') i++;
    return trim(t.substr(i)).empty();
}

struct Block {
    std::string name;
    std::vector<std::string> lines;
    int offset = 0;
};

// Le dessin, extrait de sa cloture. Le reste du fichier est ignore : on n'y
// cherche qu'un titre.
Block extract_block(const std::string& text, const std::string& source) {
    std::vector<std::string> lines;
    {
        std::istringstream in(text);
        std::string line;
        while (std::getline(in, line)) lines.push_back(rtrim(line));
    }

    std::string name;
    int start = -1;

    for (size_t i = 0; i < lines.size(); i++) {
        if (start == -1) {
            const std::string t = trim(lines[i]);
            if (name.empty() && t.rfind("# ", 0) == 0) {
                name = trim(t.substr(2));
            }
            if (is_fence_open(lines[i])) start = static_cast<int>(i);
            continue;
        }
        if (is_fence_close(lines[i])) {
            Block block;
            block.name = name;
            block.lines.assign(lines.begin() + start + 1, lines.begin() + i);
            block.offset = start + 2;
            return block;
        }
    }

    if (start != -1) fail(source, start + 1, "bloc ```track jamais referme.");
    fail(source, 0, "aucun bloc ```track. Un circuit se dessine entre ```track et ```.");
}

std::string basename_no_ext(const std::string& path) {
    size_t slash = path.find_last_of('/');
    std::string name = (slash == std::string::npos) ? path : path.substr(slash + 1);
    if (name.size() > 3 && name.substr(name.size() - 3) == ".md") {
        name = name.substr(0, name.size() - 3);
    }
    return name;
}

bool dir_exists(const std::string& path) {
    struct stat st {};
    return !path.empty() && stat(path.c_str(), &st) == 0 && S_ISDIR(st.st_mode);
}

std::string lower(std::string s) {
    for (char& c : s) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
    return s;
}

} // namespace

Track parse_track(const std::string& text, const std::string& source) {
    const Block block = extract_block(text, source);

    std::vector<std::string> rows = block.lines;

    // Les lignes vides d'entree et de sortie sont du confort de redaction.
    int first = 0;
    int last = static_cast<int>(rows.size()) - 1;
    while (first <= last && rows[static_cast<size_t>(first)].empty()) first++;
    while (last >= first && rows[static_cast<size_t>(last)].empty()) last--;

    if (last - first < 2) {
        fail(source, block.offset, "un circuit demande au moins trois lignes : "
            "le bord du fond, une rangee de piste, le bord de devant.");
    }

    const auto line_no = [&](int i) { return block.offset + i; };

    for (int i = first; i <= last; i++) {
        if (rows[static_cast<size_t>(i)].find('\t') != std::string::npos) {
            fail(source, line_no(i), "tabulation dans le dessin : sa largeur depend de "
                "l'editeur, donc la colonne n'est plus lisible. Mettre des espaces.");
        }
    }

    // Les deux bords donnent la longueur du tour. Ils sont pleins et de meme
    // longueur, sans quoi la piste n'aurait ni debut ni fin nets.
    const int columns = static_cast<int>(rows[static_cast<size_t>(first)].size());
    for (int i : { first, last }) {
        const std::string& row = rows[static_cast<size_t>(i)];
        const bool onlyX = !row.empty()
            && row.find_first_not_of('X') == std::string::npos;
        if (!onlyX) {
            fail(source, line_no(i), "la premiere et la derniere ligne du dessin sont les "
                "bords de piste : que des X. Lue : \"" + row + "\".");
        }
        if (static_cast<int>(row.size()) != columns) {
            fail(source, line_no(i), "bords de longueurs differentes ("
                + std::to_string(rows[static_cast<size_t>(first)].size()) + " et "
                + std::to_string(rows[static_cast<size_t>(last)].size())
                + " colonnes) : le tour n'a pas de longueur.");
        }
    }

    Track track;
    int finishColumn = -1;
    int finishLine = 0;

    for (int i = first + 1; i < last; i++) {
        const std::string& row = rows[static_cast<size_t>(i)];
        if (static_cast<int>(row.size()) > columns) {
            fail(source, line_no(i), std::to_string(row.size())
                + " colonnes alors que les bords en font " + std::to_string(columns)
                + " : quelque chose deborde de la piste.");
        }

        for (int col = 0; col < static_cast<int>(row.size()); col++) {
            const char ch = row[static_cast<size_t>(col)];

            if (ch == ' ' || ch == '.') continue;

            if (ch == 'X') {
                fail(source, line_no(i), "X en colonne " + std::to_string(col)
                    + " : une piste de largeur variable n'est pas encore supportee. "
                      "Les X ne vont que sur les deux lignes de bord.");
            }

            if (ch == 'x') {
                if (finishColumn != -1 && finishColumn != col) {
                    fail(source, line_no(i), "ligne d'arrivee en colonne "
                        + std::to_string(col) + " alors qu'elle est deja en colonne "
                        + std::to_string(finishColumn) + " (ligne "
                        + std::to_string(finishLine) + ") : elle traverse la piste "
                          "tout droit, donc une seule colonne.");
                }
                finishColumn = col;
                finishLine = line_no(i);
                continue;
            }

            if (ch == 'B') {
                track.boxes.push_back({ col, i - first - 1 });
                continue;
            }

            if (ch == 'P' || ch == 'p') {
                track.pipes.push_back({ col, i - first - 1, ch == 'p' });
                continue;
            }

            fail(source, line_no(i), std::string("caractere \"") + ch + "\" inconnu en colonne "
                + std::to_string(col) + ". Le dessin ne connait que X (bord), x (ligne), "
                  "B (boite), P (pipe vert), p (pipe rouge) et l'espace.");
        }
    }

    if (finishColumn == -1) {
        fail(source, block.offset, "aucune ligne de depart/arrivee : il manque un x.");
    }
    if (track.boxes.empty()) {
        fail(source, block.offset, "aucune boite a objets : il manque au moins un B. "
            "Sans boite, personne ne recoit rien de la course entiere.");
    }

    track.name = block.name.empty() ? basename_no_ext(source) : block.name;
    track.source = source;
    track.columns = columns;
    track.rows = last - first - 1;
    track.finishColumn = finishColumn;
    return track;
}

Passage narrowest_passage(const config::Config& cfg,
                          const std::vector<std::pair<double, double>>& pipes,
                          double width) {
    const double hx = cfg.hitboxes.kartVsPipe.x;
    const double hy = cfg.hitboxes.kartVsPipe.y;
    const double step = std::max(4.0, hx / 2);

    Passage worst { cfg.road.maxY - cfg.road.minY, 0 };

    for (double x = 0; x < width; x += step) {
        // Deux tuyaux voisins sans etre alignes se recouvrent partiellement, et
        // c'est cette zone qui decide du passage : il faut BALAYER la piste, pas
        // seulement regarder chaque colonne dessinee.
        std::vector<std::pair<double, double>> blocked;
        for (const auto& pipe : pipes) {
            double d = pipe.first - x;
            if (d < -width * 0.5) d += width;
            if (d > width * 0.5) d -= width;
            if (std::abs(d) >= hx) continue;
            blocked.emplace_back(pipe.second - hy, pipe.second + hy);
        }
        if (blocked.empty()) continue;

        std::sort(blocked.begin(), blocked.end());

        double free = 0;
        double cursor = cfg.road.minY;
        for (const auto& span : blocked) {
            if (span.first > cursor) free = std::max(free, span.first - cursor);
            if (span.second > cursor) cursor = span.second;
        }
        free = std::max(free, cfg.road.maxY - cursor);

        if (free < worst.free) {
            worst.free = free;
            worst.x = x;
        }
    }

    return worst;
}

config::Config apply_track(const config::Config& cfg, Track& track) {
    const double width = track.columns * CELL_PX;

    // La grille se deploie EN AMONT de la ligne. Si le tour est plus court que
    // ce qu'elle occupe, le fond de grille depasse la ligne par l'arriere et les
    // karts partent avec un tour d'avance sur eux-memes.
    const config::GridCfg& grid = cfg.race.grid;
    const double gridDepth = grid.backOffset + 3 * grid.rowGap + grid.colStagger;
    if (width < gridDepth * 2) {
        fail(track.source, 0, "tour de " + std::to_string(static_cast<long long>(width))
            + " px (" + std::to_string(track.columns) + " colonnes) trop court : la grille "
              "de depart en occupe deja " + std::to_string(static_cast<long long>(gridDepth))
            + ". Il en faut au moins "
            + std::to_string(static_cast<long long>(std::ceil((gridDepth * 2) / CELL_PX)))
            + " colonnes.");
    }

    config::Config out = cfg;
    out.world.width = width;
    out.world.finishLineX = track.finishColumn * CELL_PX;

    // Rangee du haut = fond de piste = `road.maxY`, `yPercent` etant une hauteur
    // a l'ecran. Une seule rangee dessinee ne designe aucun bord : donc le
    // milieu.
    const double depth = cfg.road.maxY - cfg.road.minY;
    const auto rowY = [&](int row) {
        return (track.rows > 1)
            ? cfg.road.maxY - row * (depth / (track.rows - 1))
            : cfg.road.minY + depth / 2;
    };

    out.world.itemBoxes.clear();
    for (const Cell& box : track.boxes) {
        out.world.itemBoxes.push_back({ box.col * CELL_PX, rowY(box.row), false });
    }

    out.world.pipes.clear();
    for (const PipeCell& pipe : track.pipes) {
        out.world.pipes.push_back({ pipe.col * CELL_PX, rowY(pipe.row), pipe.red });
    }

    // Un mur de tuyaux ne provoquerait aucune erreur a l'execution : les karts se
    // cogneraient jusqu'au delai maximum et la course serait close sur un
    // classement d'office. Rien dans les journaux ne dirait que le circuit est en
    // cause — d'ou ce refus au CHARGEMENT, seul endroit ou le probleme est
    // visible.
    if (!out.world.pipes.empty()) {
        std::vector<std::pair<double, double>> flat;
        flat.reserve(out.world.pipes.size());
        for (const config::Placed& p : out.world.pipes) flat.emplace_back(p.x, p.y);

        const Passage passage = narrowest_passage(cfg, flat, width);
        if (passage.free < cfg.pipe.minPassageY) {
            char buf[64];
            std::snprintf(buf, sizeof(buf), "%.1f", passage.free);
            fail(track.source, 0, "piste bouchee vers x="
                + std::to_string(static_cast<long long>(std::llround(passage.x)))
                + " (colonne "
                + std::to_string(static_cast<long long>(std::llround(passage.x / CELL_PX)))
                + ") : il ne reste que " + buf + " de passage libre en profondeur, il en "
                  "faut " + std::to_string(static_cast<long long>(cfg.pipe.minPassageY))
                + ". Deplacer ou retirer un pipe (P ou p).");
        }
    }

    track.warnings.clear();

    // Une boite posee dans l'ombre de la grille est ramassee par le peloton dans
    // la seconde qui suit le depart, avant meme que qui que ce soit ait pu
    // manoeuvrer pour l'avoir.
    for (const config::Placed& box : out.world.itemBoxes) {
        double gap = out.world.finishLineX - box.x;
        if (gap < 0) gap += width;
        if (gap > 0 && gap < gridDepth) {
            track.warnings.push_back("boite a "
                + std::to_string(static_cast<long long>(std::llround(gap)))
                + " px derriere la ligne, dans la grille de depart (profonde de "
                + std::to_string(static_cast<long long>(gridDepth)) + " px).");
        }
    }

    for (const config::Placed& pipe : out.world.pipes) {
        // Un tuyau dans la grille, c'est le peloton a l'arret qui se le partage
        // au feu vert — voire un kart qui demarre dedans.
        double gap = out.world.finishLineX - pipe.x;
        if (gap < 0) gap += width;
        if (gap > 0 && gap < gridDepth) {
            track.warnings.push_back("pipe a "
                + std::to_string(static_cast<long long>(std::llround(gap)))
                + " px derriere la ligne, dans la grille de depart : le peloton le "
                  "prendra au feu vert.");
        }

        // Un tuyau pose devant une boite la rend inatteignable : le kart qui la
        // vise doit precisement passer la ou le tuyau ne le laisse pas.
        for (const config::Placed& box : out.world.itemBoxes) {
            double ahead = box.x - pipe.x;
            if (ahead < -width * 0.5) ahead += width;
            if (ahead > width * 0.5) ahead -= width;
            if (ahead > 0 && ahead < cfg.hitboxes.kartVsPipe.x * 2
                && std::abs(box.y - pipe.y) < cfg.hitboxes.kartVsPipe.y) {
                char buf[32];
                std::snprintf(buf, sizeof(buf), "%.1f", pipe.y);
                track.warnings.push_back("pipe juste devant une boite (x="
                    + std::to_string(static_cast<long long>(std::llround(pipe.x)))
                    + ", profondeur " + buf + ") : elle sera difficile a prendre.");
            }
        }
    }

    // Deux tours pleins, plus la marge de la config : la camera ne sait que
    // ralentir, il lui faut ce couloir pour se garer pile sur la ligne. Derivee
    // et non ecrite en dur, sinon chaque circuit d'une autre longueur
    // redemanderait le calcul a la main.
    out.race.cameraApproachDistance = 2 * width + cfg.race.cameraApproachMargin;

    return out;
}

std::string resolve_tracks_dir(const std::string& base) {
    std::vector<std::string> candidates;
    if (const char* env = std::getenv("TRACKS_DIR")) candidates.emplace_back(env);
    candidates.push_back(base + "/tracks");
    candidates.push_back(base + "/../tracks");
    candidates.push_back(base + "/../../tracks");

    for (const std::string& dir : candidates) {
        if (dir_exists(dir)) return dir;
    }

    std::string tried;
    for (size_t i = 0; i < candidates.size(); i++) {
        if (i) tried += ", ";
        tried += candidates[i];
    }
    throw TrackError("dossier tracks/ introuvable (cherche dans : " + tried + "). "
        "Dans le conteneur il est monte par docker-compose : le moteur y est copie, "
        "les circuits non, pour se retoucher sans reconstruire l'image.");
}

std::vector<Track> load_tracks(const std::string& dir, const config::Config& cfg) {
    std::vector<std::string> files;

    DIR* handle = opendir(dir.c_str());
    if (!handle) {
        throw TrackError("impossible de lire " + dir);
    }
    while (dirent* entry = readdir(handle)) {
        const std::string name = entry->d_name;
        const std::string low = lower(name);
        if (low.size() < 4 || low.substr(low.size() - 3) != ".md") continue;
        if (low == "readme.md") continue;
        files.push_back(name);
    }
    closedir(handle);

    if (files.empty()) {
        throw TrackError("aucun circuit dans " + dir + " : il faut au moins un .md "
            "dessine. Voir tracks/README.md pour le format.");
    }

    // L'ordre des noms de fichiers EST l'ordre des manches.
    std::sort(files.begin(), files.end());

    std::vector<Track> tracks;
    tracks.reserve(files.size());
    for (const std::string& name : files) {
        std::ifstream in(dir + "/" + name);
        if (!in) throw TrackError("impossible d'ouvrir " + dir + "/" + name);
        std::stringstream buffer;
        buffer << in.rdbuf();

        Track parsed = parse_track(buffer.str(), name);
        // Le resultat est jete : seules les erreurs qu'il leve nous interessent,
        // et les avertissements qu'il pose sur le circuit. Chaque course refera
        // le calcul sur sa propre config.
        apply_track(cfg, parsed);
        tracks.push_back(std::move(parsed));
    }

    return tracks;
}

const Track& for_round(const std::vector<Track>& tracks, int round) {
    const int n = static_cast<int>(tracks.size());
    const int idx = ((round - 1) % n + n) % n;
    return tracks[static_cast<size_t>(idx)];
}

} // namespace track
