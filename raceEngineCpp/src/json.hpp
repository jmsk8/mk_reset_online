// Ecriture et lecture JSON, reduites a ce que le protocole echange.
//
// Ecriture : un tampon et quelques primitives, pas de DOM intermediaire — le
// snapshot part dix fois par seconde a chaque spectateur, le construire en
// arbre pour le serialiser ensuite serait deux fois le travail.
//
// Lecture : les QUATRE messages clients, et rien d'autre. Un flux de lecture n'a
// aucune raison legitime de recevoir autre chose (plan §5.3).

#pragma once

#include <string>
#include <string_view>

namespace json {

// ── Ecriture ────────────────────────────────────────────────────────────────

class Writer {
public:
    void begin_object();
    void end_object();
    void begin_array();
    void end_array();

    // Une cle, suivie de sa valeur. `key` doit etre un litteral ASCII : le
    // protocole n'a pas de cle dynamique.
    void key(std::string_view k);

    void number(double v);
    void integer(long long v);
    void string(std::string_view v);
    void boolean(bool v);
    void null();

    // Un element de tableau, sans cle.
    void raw(std::string_view v);

    const std::string& str() const { return buffer_; }
    void clear();

private:
    void separate();
    // Ecrit l'entier sans poser de separateur : `number()` s'en sert apres
    // avoir deja appele `separate()`, et le faire deux fois insererait une
    // virgule au milieu d'une valeur.
    void integer_no_sep(long long v);

    std::string buffer_;
    bool needComma_ = false;
};

// ── Lecture ─────────────────────────────────────────────────────────────────

// Ce que le client peut envoyer. Tout le reste est ignore en silence.
enum class ClientMessageType {
    Unknown,
    Ping,
    Vote,
    Watch,
    Vis
};

struct ClientMessage {
    ClientMessageType type = ClientMessageType::Unknown;

    // `ping` : renvoye TEL QUEL dans le `pong`. C'est le client qui l'a ecrit,
    // il ne se relit pas comme un nombre — un horodatage peut deborder.
    std::string pingToken;

    // `watch` : l'id demande. `hasId` faux vaut « rends-moi le flux commun ».
    // A ne surtout pas passer par une conversion qui rendrait 0 — soit le kart
    // 0, donc l'inverse exact de ce qui est demande.
    bool hasId = false;
    long long watchId = 0;

    // `vis`
    bool hidden = false;
};

// Analyse un message client. Rend `Unknown` sur tout ce qui n'est pas l'un des
// quatre — y compris un JSON invalide, qui n'a pas a etre signale : ce serait
// repondre a une tentative.
ClientMessage parse_client_message(std::string_view payload);

} // namespace json
