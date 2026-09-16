#!/usr/bin/env python3
"""Build a local macOS app, optionally install it into ~/Applications."""
import argparse
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parent.parent
BUNDLE_ID = "com.resumemm.desktop"


def run(*args, **kwargs):
    subprocess.run(args, cwd=ROOT, check=True, **kwargs)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--install", action="store_true")
    parser.add_argument("--install-only", action="store_true", help="Install the already built app")
    args = parser.parse_args()
    if sys.platform != "darwin":
        parser.error("Building ResumeM-M.app requires macOS and Xcode Command Line Tools.")
    output = ROOT / "dist" / "macos" / "ResumeM-M.app"
    if not args.install_only:
        node = shutil.which("node")
        if not node:
            parser.error("Install Node.js 20 or newer before building the Mac app.")
        run("npm", "run", "build")
        # Resolve against the original project so existing in-tree stores and
        # explicit RMM_DATA settings survive packaging unchanged.
        store = subprocess.check_output([
            node, "--input-type=module", "-e",
            "import {resolveStoreDir} from './dist/src/model/location.js'; console.log(resolveStoreDir(process.cwd()));",
        ], cwd=ROOT, text=True).strip()
        version = json.loads((ROOT / "package.json").read_text())["version"]
        with tempfile.TemporaryDirectory(prefix="rmm-macos-") as temporary:
            temporary = Path(temporary)
            bundle = temporary / "ResumeM-M.app"
            contents = bundle / "Contents"
            resources = contents / "Resources"
            executable = contents / "MacOS" / "ResumeM-M"
            executable.parent.mkdir(parents=True)
            resources.mkdir()
            runtime = resources / "server"
            runtime.mkdir()
            shutil.copytree(ROOT / "dist" / "src", runtime / "src")
            shutil.copytree(ROOT / "web", runtime / "web")
            shutil.copytree(ROOT / "data", runtime / "data", ignore=shutil.ignore_patterns(".git", "out", ".DS_Store"))
            # Snapshot dependencies as well: the installed app does not need
            # this checkout, a dev server, or npm at launch time.
            shutil.copytree(ROOT / "node_modules", runtime / "node_modules", symlinks=True)
            shutil.copy2(ROOT / "package.json", runtime / "package.json")
            shutil.copy2(ROOT / "macos" / "bootstrap.mjs", runtime / "bootstrap.mjs")
            search_path = os.pathsep.join(dict.fromkeys([
                str(Path(node).parent), str(Path.home() / ".local" / "bin"),
                "/opt/homebrew/bin", "/usr/local/bin", "/Library/TeX/texbin",
                *os.environ.get("PATH", "").split(os.pathsep), "/usr/bin", "/bin",
            ]))
            (resources / "configuration.json").write_text(json.dumps({
                "node": node, "path": search_path, "dataDir": store,
            }, indent=2) + "\n")
            with (contents / "Info.plist").open("wb") as stream:
                plistlib.dump({
                    "CFBundleName": "ResumeM-M",
                    "CFBundleDisplayName": "ResumeM-M",
                    "CFBundleIdentifier": BUNDLE_ID,
                    "CFBundleExecutable": "ResumeM-M",
                    "CFBundlePackageType": "APPL",
                    "CFBundleShortVersionString": version,
                    "CFBundleVersion": version,
                    "CFBundleIconFile": "AppIcon",
                    "LSApplicationCategoryType": "public.app-category.productivity",
                    "LSMinimumSystemVersion": "12.0",
                    "NSHighResolutionCapable": True,
                    "NSPrincipalClass": "NSApplication",
                    "NSAppTransportSecurity": {"NSAllowsLocalNetworking": True},
                }, stream)
            cache = ROOT / "dist" / "macos" / "module-cache"
            cache.mkdir(parents=True, exist_ok=True)
            flags = ["-O", "-swift-version", "5", "-module-cache-path", str(cache),
                     "-target", f"{os.uname().machine}-apple-macosx12.0"]
            run("xcrun", "swiftc", *flags, str(ROOT / "macos" / "App.swift"), "-o", str(executable))
            icon_tool = temporary / "draw-icon"
            run("xcrun", "swiftc", *flags, str(ROOT / "macos" / "Icon.swift"), "-o", str(icon_tool))
            iconset = temporary / "AppIcon.iconset"
            iconset.mkdir()
            run(str(icon_tool), str(iconset))
            run("iconutil", "-c", "icns", str(iconset), "-o", str(resources / "AppIcon.icns"))
            run("codesign", "--force", "--sign", "-", str(bundle))
            if output.exists():
                shutil.rmtree(output)
            output.parent.mkdir(parents=True, exist_ok=True)
            shutil.copytree(bundle, output, symlinks=True)
        print(f"Built {output}", flush=True)
    if args.install or args.install_only:
        if not output.is_dir():
            parser.error("No built app found. Run npm run mac:build first.")
        destination = Path.home() / "Applications" / "ResumeM-M.app"
        if destination.exists():
            with (destination / "Contents" / "Info.plist").open("rb") as stream:
                if plistlib.load(stream).get("CFBundleIdentifier") != BUNDLE_ID:
                    parser.error(f"Refusing to replace an unrelated app at {destination}")
            # Require the user to quit first so a running app cannot end up
            # using a mixture of the old and new resource files.
            running = subprocess.run(["pgrep", "-f", str(destination / "Contents" / "MacOS" / "ResumeM-M")], capture_output=True)
            if running.returncode == 0:
                parser.error("Quit ResumeM-M, then run npm run mac:install again.")
            shutil.rmtree(destination)
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(output, destination, symlinks=True)
        run("/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister", "-f", str(destination))
        # Indexing is asynchronous; registration still makes it launchable
        # immediately via Finder, Dock, or `open -a ResumeM-M`.
        run("mdimport", str(destination))
        print(f"Installed {destination}\nSearch Spotlight for ResumeM-M to open it.")


if __name__ == "__main__":
    main()
