#include "json.hpp"

#include <array>
#include <charconv>
#include <cmath>
#include <cstdlib>
#include <system_error>

namespace json {

// ── Ecriture ────────────────────────────────────────────────────────────────

void Writer::clear() {
    buffer_.clear();
    needComma_ = false;
}

void Writer::separate() {
    if (needComma_) buffer_ += ',';
    needComma_ = true;
}

void Writer::begin_object() {
    separate();
    buffer_ += '{';
    needComma_ = false;
}

void Writer::end_object() {
    buffer_ += '}';
    needComma_ = true;
}

void Writer::begin_array() {
    separate();
    buffer_ += '[';
    needComma_ = false;
}

void Writer::end_array() {
    buffer_ += ']';
    needComma_ = true;
}

void Writer::key(std::string_view k) {
    separate();
    buffer_ += '"';
    buffer_.append(k);
    buffer_ += "\":";
    // La valeur qui suit ne doit pas remettre de virgule.
    needComma_ = false;
}

void Writer::number(double v) {
    separate();

    // Un NaN ou un infini n'a pas de representation JSON. Le laisser passer
    // produirait un message que le client rejetterait en bloc, sans dire
    // pourquoi : `null` est au moins lisible, et le controle d'integrite du
    // service, lui, criera.
    if (!std::isfinite(v)) {
        buffer_ += "null";
        return;
    }

    // Un entier s'ecrit en entier : `1.0` doit sortir `1`, comme en JS.
    if (v == static_cast<double>(static_cast<long long>(v))
        && std::abs(v) < 9e15) {
        integer_no_sep(static_cast<long long>(v));
        return;
    }

    // `std::to_chars` SANS precision : representation decimale la plus courte
    // qui relit a l'identique — le meme algorithme que
    // `Number.prototype.toString` (plan §5.4). Avec une precision fixe, on
    // ecrirait `0.30000000000000004` ou on perdrait des decimales utiles.
    std::array<char, 32> tmp {};
    auto res = std::to_chars(tmp.data(), tmp.data() + tmp.size(), v);
    if (res.ec == std::errc()) {
        buffer_.append(tmp.data(), res.ptr);
    } else {
        buffer_ += "null";
    }
}

void Writer::integer_no_sep(long long v) {
    std::array<char, 24> tmp {};
    auto res = std::to_chars(tmp.data(), tmp.data() + tmp.size(), v);
    if (res.ec == std::errc()) {
        buffer_.append(tmp.data(), res.ptr);
    } else {
        buffer_ += '0';
    }
}

void Writer::integer(long long v) {
    separate();
    integer_no_sep(v);
}

void Writer::string(std::string_view v) {
    separate();
    buffer_ += '"';
    for (char c : v) {
        switch (c) {
            case '"':  buffer_ += "\\\""; break;
            case '\\': buffer_ += "\\\\"; break;
            case '\n': buffer_ += "\\n"; break;
            case '\r': buffer_ += "\\r"; break;
            case '\t': buffer_ += "\\t"; break;
            default:
                if (static_cast<unsigned char>(c) < 0x20) {
                    // Les caracteres de controle doivent etre echappes en \u.
                    static const char* hex = "0123456789abcdef";
                    buffer_ += "\\u00";
                    buffer_ += hex[(c >> 4) & 0xF];
                    buffer_ += hex[c & 0xF];
                } else {
                    buffer_ += c;
                }
        }
    }
    buffer_ += '"';
}

void Writer::boolean(bool v) {
    separate();
    buffer_ += v ? "true" : "false";
}

void Writer::null() {
    separate();
    buffer_ += "null";
}

void Writer::raw(std::string_view v) {
    separate();
    buffer_.append(v);
}

// ── Lecture ─────────────────────────────────────────────────────────────────
//
// Un analyseur minimal, volontairement : le service accepte quatre messages
// plats de quelques dizaines d'octets, plafonnes a 512. Y brancher une
// bibliotheque generale serait une dependance de plus pour lire `{"t":"ping"}`.

namespace {

void skip_spaces(std::string_view s, size_t& i) {
    while (i < s.size() && (s[i] == ' ' || s[i] == '\t' || s[i] == '\n' || s[i] == '\r')) i++;
}

// Lit une chaine JSON a partir du guillemet ouvrant. Rend false si elle est
// malformee ; les echappements autres que \" et \\ sont recopies tels quels,
// ce qui suffit aux valeurs que le client envoie.
bool read_string(std::string_view s, size_t& i, std::string& out) {
    if (i >= s.size() || s[i] != '"') return false;
    i++;
    out.clear();
    while (i < s.size()) {
        const char c = s[i];
        if (c == '"') { i++; return true; }
        if (c == '\\') {
            i++;
            if (i >= s.size()) return false;
            const char e = s[i];
            switch (e) {
                case 'n': out += '\n'; break;
                case 't': out += '\t'; break;
                case 'r': out += '\r'; break;
                case 'b': out += '\b'; break;
                case 'f': out += '\f'; break;
                case 'u': {
                    // Les quatre chiffres sont ignores : aucun champ lu ici
                    // n'est du texte affiche, et `t` ne contient que de l'ASCII.
                    if (i + 4 >= s.size()) return false;
                    i += 4;
                    break;
                }
                default: out += e;
            }
            i++;
            continue;
        }
        out += c;
        i++;
    }
    return false;
}

// Lit un scalaire (nombre, bool, null) sans l'interpreter : la valeur brute
// suffit a decider ensuite.
void read_scalar(std::string_view s, size_t& i, std::string& out) {
    out.clear();
    while (i < s.size() && s[i] != ',' && s[i] != '}' && s[i] != ']') {
        out += s[i];
        i++;
    }
    // Rogne les espaces de fin.
    while (!out.empty() && (out.back() == ' ' || out.back() == '\n'
                            || out.back() == '\t' || out.back() == '\r')) {
        out.pop_back();
    }
}

} // namespace

ClientMessage parse_client_message(std::string_view payload) {
    ClientMessage msg;

    size_t i = 0;
    skip_spaces(payload, i);
    if (i >= payload.size() || payload[i] != '{') return msg;
    i++;

    std::string type;
    std::string pingToken;
    std::string watchRaw;
    std::string hiddenRaw;

    while (i < payload.size()) {
        skip_spaces(payload, i);
        if (i < payload.size() && payload[i] == '}') break;

        std::string key;
        if (!read_string(payload, i, key)) return ClientMessage {};

        skip_spaces(payload, i);
        if (i >= payload.size() || payload[i] != ':') return ClientMessage {};
        i++;
        skip_spaces(payload, i);
        if (i >= payload.size()) return ClientMessage {};

        std::string value;
        if (payload[i] == '"') {
            if (!read_string(payload, i, value)) return ClientMessage {};
        } else if (payload[i] == '{' || payload[i] == '[') {
            // Aucun message client n'a de valeur composee. En rencontrer une
            // veut dire que ce n'est pas l'un des quatre : on abandonne.
            return ClientMessage {};
        } else {
            read_scalar(payload, i, value);
        }

        if (key == "t") type = value;
        else if (key == "c") pingToken = value;
        else if (key == "id") watchRaw = value;
        else if (key == "hidden") hiddenRaw = value;

        skip_spaces(payload, i);
        if (i < payload.size() && payload[i] == ',') { i++; continue; }
        if (i < payload.size() && payload[i] == '}') break;
    }

    if (type == "ping") {
        msg.type = ClientMessageType::Ping;
        msg.pingToken = pingToken;
    } else if (type == "vote") {
        msg.type = ClientMessageType::Vote;
    } else if (type == "watch") {
        msg.type = ClientMessageType::Watch;
        // `null` explicite, ou absent : le client rend la connexion au flux
        // commun. Surtout pas une conversion qui rendrait 0.
        if (!watchRaw.empty() && watchRaw != "null") {
            errno = 0;
            char* end = nullptr;
            const long long parsed = std::strtoll(watchRaw.c_str(), &end, 10);
            if (end != watchRaw.c_str() && errno == 0) {
                msg.hasId = true;
                msg.watchId = parsed;
            }
        }
    } else if (type == "vis") {
        msg.type = ClientMessageType::Vis;
        msg.hidden = (hiddenRaw == "true");
    }

    return msg;
}

} // namespace json
