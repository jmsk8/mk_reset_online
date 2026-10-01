// Ecriture et lecture JSON, limitees a ce que le protocole echange.
//
// Ecriture dans un tampon, sans DOM intermediaire. Lecture des seuls messages
// clients.

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

    // `key` doit etre un litteral ASCII.
    void key(std::string_view k);

    void number(double v);
    void integer(long long v);
    void string(std::string_view v);
    void boolean(bool v);
    void null();

    // Element de tableau, sans cle.
    void raw(std::string_view v);

    const std::string& str() const { return buffer_; }
    void clear();

private:
    void separate();
    // Sans separateur : `number()` l'appelle apres `separate()`.
    void integer_no_sep(long long v);

    std::string buffer_;
    bool needComma_ = false;
};

// ── Lecture ─────────────────────────────────────────────────────────────────

// Messages acceptes ; le reste est ignore.
enum class ClientMessageType {
    Unknown,
    Hi,
    Ping,
    Vote,
    Watch,
    Vis
};

struct ClientMessage {
    ClientMessageType type = ClientMessageType::Unknown;

    // `ping` : renvoye tel quel dans le `pong` (non converti en nombre, pour
    // ne pas deborder).
    std::string pingToken;

    // `watch` : `hasId` faux = flux commun (ne pas le confondre avec le kart 0).
    bool hasId = false;
    long long watchId = 0;

    // `vis` et `hi`
    bool hidden = false;

    // `hi` : identifiant du navigateur. Vide s'il est absent ou hors de
    // [A-Za-z0-9_-]{16,64}.
    std::string nav;
};

// Analyse un message client. Rend `Unknown` pour tout le reste, JSON invalide
// compris.
ClientMessage parse_client_message(std::string_view payload);

} // namespace json
