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
      ../backEnd/db.sql

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
