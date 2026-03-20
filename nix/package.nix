{
  stdenvNoCC,
  lib,
}:
stdenvNoCC.mkDerivation {
  name = "mk_reset";
  version = "1.0.0";

  src = lib.fileset.toSource {
    root = ./..;
    fileset = lib.fileset.unions [
      ../backEnd/backend.py
      ../backEnd/routes_public.py
      ../backEnd/routes_admin.py
      ../backEnd/services.py
      ../backEnd/db.py
      ../backEnd/auth.py
      ../backEnd/cache.py
      ../backEnd/constants.py
      ../backEnd/utils.py
      ../backEnd/schema.sql
      ../backEnd/seed.sql
      ../backEnd/dump.sql

      ../frontEnd/static
      ../frontEnd/templates
      ../frontEnd/frontend.py
    ];
  };

  installPhase = ''
    mkdir -p $out/
    cp -r . $out/
  '';
}
