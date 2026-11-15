from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path, PurePosixPath
from typing import Any

if __package__:
    from .check_public_artifact import scan_text
else:
    from check_public_artifact import scan_text


SOURCE_REPOSITORY = 'winterinabluu/kpop-pulse'
SOURCE_WORKFLOW = '.github/workflows/pages-candidate.yml'
SOURCE_EVENTS = {
    SOURCE_WORKFLOW: {'workflow_dispatch'},
    '.github/workflows/pages.yml': {'push', 'workflow_dispatch'},
    '.github/workflows/update-data.yml': {'schedule', 'workflow_dispatch'},
}
ARTIFACT_NAME = 'pages-candidate'
MAX_FILE_BYTES = 8 * 1024 * 1024
MAX_SITE_BYTES = 32 * 1024 * 1024
MAX_FILES = 1024
REQUIRED_FILES = {
    '.nojekyll', 'index.html', 'privacy.html', 'terms.html', 'x-embed.html',
    'data/config.json', 'data/meta.json', 'data/news.json', 'data/youtube.json',
    'data/curated.json', 'data/x.json', 'src/app.js', 'src/styles.css',
}
IDENTITY_KEYS = {'source_repository', 'source_ref', 'source_sha', 'source_run_id', 'source_run_attempt'}
MANIFEST_KEYS = IDENTITY_KEYS | {'schema_version', 'generated_at', 'expires_at', 'files', 'youtube_mode'}


class CandidateError(ValueError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise CandidateError(message)


def timestamp(value: Any) -> datetime:
    require(isinstance(value, str), 'Missing timestamp')
    try:
        parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
    except ValueError as exc:
        raise CandidateError('Invalid timestamp') from exc
    require(parsed.tzinfo is not None, 'Timestamp must include a timezone')
    return parsed.astimezone(timezone.utc)


def iso(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z')


def read_json(path: Path) -> Any:
    require(path.is_file() and not path.is_symlink(), 'Missing or unsafe JSON file')
    require(path.stat().st_size <= MAX_FILE_BYTES, 'JSON file exceeds size limit')
    def unique(pairs):
        result = {}
        for key, value in pairs:
            require(key not in result, 'Duplicate JSON property')
            result[key] = value
        return result
    try:
        return json.loads(path.read_text(encoding='utf-8'), object_pairs_hook=unique,
                          parse_constant=lambda _: (_ for _ in ()).throw(CandidateError('Non-finite JSON number')))
    except (OSError, ValueError) as exc:
        if isinstance(exc, CandidateError):
            raise
        raise CandidateError('Invalid JSON file') from exc


def allowed_path(value: Any) -> bool:
    if not isinstance(value, str) or chr(92) in value:
        return False
    path = PurePosixPath(value)
    if path.is_absolute() or path.as_posix() != value or any(part in ('.', '..') for part in path.parts):
        return False
    if value in REQUIRED_FILES:
        return True
    if not path.parts or path.parts[0] not in ('src', 'public'):
        return False
    if any(not re.fullmatch(r'[A-Za-z0-9_-][A-Za-z0-9_.-]*', part) for part in path.parts[1:]):
        return False
    suffixes = {'.js', '.mjs', '.css'} if path.parts[0] == 'src' else {'.svg', '.png', '.jpg', '.jpeg', '.webp', '.ico'}
    return path.suffix.lower() in suffixes


def inventory(site: Path) -> list[dict[str, Any]]:
    require(site.is_dir() and not site.is_symlink(), 'Missing or unsafe site directory')
    records = []
    total = 0
    for file in sorted(site.rglob('*')):
        require(not file.is_symlink() and not (hasattr(file, 'is_junction') and file.is_junction()),
                'Symbolic links and junctions are forbidden')
        if file.is_dir():
            relative = file.relative_to(site).as_posix()
            require(relative.split('/')[0] in ('src', 'public', 'data') and
                    all(re.fullmatch(r'[A-Za-z0-9_-][A-Za-z0-9_.-]*', part) for part in relative.split('/')),
                    'Unexpected static directory')
            continue
        require(file.is_file(), 'Special files are forbidden')
        relative = file.relative_to(site).as_posix()
        require(allowed_path(relative), 'Unexpected file path in site')
        size = file.stat().st_size
        require(size <= MAX_FILE_BYTES, 'Static file exceeds size limit')
        total += size
        require(total <= MAX_SITE_BYTES and len(records) < MAX_FILES, 'Static site exceeds size/count limit')
        content = file.read_bytes()
        require(len(content) == size, 'Static file changed during verification')
        require(not scan_text(content.decode('utf-8', errors='ignore')), 'Sensitive data in candidate site')
        records.append({'path': relative, 'bytes': size, 'sha256': hashlib.sha256(content).hexdigest()})
    require(REQUIRED_FILES <= {record['path'] for record in records}, 'Missing required static files')
    return records


def validate_identity(identity: dict[str, Any]) -> None:
    require(set(identity) == IDENTITY_KEYS, 'Invalid identity fields')
    require(identity['source_repository'] == SOURCE_REPOSITORY, 'Wrong source repository')
    require(identity['source_ref'] == 'refs/heads/master', 'Candidate must come from master')
    require(isinstance(identity['source_sha'], str) and re.fullmatch(r'[a-f0-9]{40}', identity['source_sha']) is not None,
            'Invalid source commit')
    require(isinstance(identity['source_run_id'], str) and re.fullmatch(r'[1-9][0-9]*', identity['source_run_id']) is not None,
            'Invalid source run ID')
    require(type(identity['source_run_attempt']) is int and identity['source_run_attempt'] >= 1, 'Invalid run attempt')


def inventory_manifest(site: Path, identity: dict[str, Any], *, now: datetime | None = None) -> dict[str, Any]:
    validate_identity(identity)
    current = now or datetime.now(timezone.utc)
    require(current.tzinfo is not None, 'Current time must include a timezone')
    return {**identity, 'schema_version': 1, 'generated_at': iso(current),
            'expires_at': iso(current + timedelta(hours=24)), 'youtube_mode': 'disabled',
            'files': inventory(site)}


def disabled_site(site: Path) -> None:
    config = read_json(site / 'data/config.json')
    require(isinstance(config, dict) and set(config) == {'schema_version', 'updated_at', 'groups', 'members'},
            'Private or invalid public config')
    require(config['schema_version'] == 1 and isinstance(config['groups'], list) and config['groups'] and
            isinstance(config['members'], list), 'Invalid public directory')
    for group in config['groups']:
        require(isinstance(group, dict) and set(group) == {'id', 'display_name', 'order', 'active'}, 'Private group config')
    for member in config['members']:
        require(isinstance(member, dict) and set(member) == {'id', 'group_id', 'display_name', 'active'}, 'Private member config')
    youtube = read_json(site / 'data/youtube.json')
    require(isinstance(youtube, dict) and youtube.get('source') == 'youtube' and youtube.get('items') == [],
            'Live YouTube data is forbidden in this candidate')
    status = youtube.get('status', {})
    require(status.get('code') == 'disabled' and status.get('ok') is False and status.get('item_count') == 0,
            'YouTube candidate must be disabled')
    meta = read_json(site / 'data/meta.json')
    source = meta.get('sources', {}).get('youtube', {})
    require(source.get('status') == 'disabled' and source.get('ok') is False and source.get('item_count') == 0,
            'YouTube metadata must also be disabled')


def verify_bundle(bundle: Path, run: dict[str, Any], artifact: dict[str, Any], *, now: datetime | None = None) -> Path:
    require(isinstance(run, dict) and isinstance(artifact, dict), 'Invalid external identity metadata')
    require(bundle.is_dir() and not bundle.is_symlink(), 'Missing or unsafe bundle')
    require({file.name for file in bundle.iterdir()} == {'site', 'manifest.json'}, 'Unexpected bundle root entries')
    manifest = read_json(bundle / 'manifest.json')
    require(isinstance(manifest, dict) and set(manifest) == MANIFEST_KEYS, 'Invalid manifest fields')
    validate_identity({key: manifest[key] for key in IDENTITY_KEYS})
    require(manifest['schema_version'] == 1 and manifest['youtube_mode'] == 'disabled', 'Unsupported candidate mode')
    current = now or datetime.now(timezone.utc)
    generated = timestamp(manifest['generated_at']); expires = timestamp(manifest['expires_at'])
    require(generated <= current < expires and expires - generated == timedelta(hours=24), 'Candidate expired, future or over-retained')
    require(run.get('repository', {}).get('full_name') == SOURCE_REPOSITORY, 'Untrusted run repository')
    require(str(run.get('id')) == manifest['source_run_id'] and run.get('run_attempt') == manifest['source_run_attempt'],
            'Run ID/attempt mismatch')
    require(run.get('head_sha') == manifest['source_sha'] and run.get('head_branch') == 'master', 'Run commit/ref mismatch')
    require(run.get('event') in SOURCE_EVENTS.get(run.get('path'), set()), 'Unexpected producer workflow/event')
    require(run.get('status') == 'completed' and run.get('conclusion') == 'success', 'Producer did not complete successfully')
    run_created = timestamp(run.get('created_at')); run_completed = timestamp(run.get('updated_at'))
    require(run_created <= generated <= run_completed <= current, 'Candidate does not belong to this run lifetime')
    require(artifact.get('name') == ARTIFACT_NAME and artifact.get('expired') is False, 'Unexpected or expired artifact')
    artifact_run = artifact.get('workflow_run', {})
    require(str(artifact_run.get('id')) == manifest['source_run_id'] and artifact_run.get('head_sha') == manifest['source_sha'],
            'Artifact source-run mismatch')
    created = timestamp(artifact.get('created_at')); retained_until = timestamp(artifact.get('expires_at'))
    require(generated <= created <= run_completed <= current < retained_until and
            timedelta(0) < retained_until - created <= timedelta(hours=24, minutes=5), 'Artifact expiry/retention mismatch')
    records = manifest['files']
    require(isinstance(records, list) and 0 < len(records) <= MAX_FILES, 'Invalid manifest inventory')
    seen = set()
    for record in records:
        require(isinstance(record, dict) and set(record) == {'path', 'bytes', 'sha256'}, 'Invalid file record')
        require(allowed_path(record['path']) and record['path'] not in seen, 'Unsafe or duplicate inventory path')
        require(type(record['bytes']) is int and 0 <= record['bytes'] <= MAX_FILE_BYTES, 'Invalid file size')
        require(isinstance(record['sha256'], str) and re.fullmatch(r'[a-f0-9]{64}', record['sha256']) is not None, 'Invalid file digest')
        seen.add(record['path'])
    site = bundle / 'site'
    require(sorted(records, key=lambda record: record['path']) == inventory(site), 'Candidate inventory/digest mismatch')
    disabled_site(site)
    return site


def main() -> int:
    parser = argparse.ArgumentParser(description='Verify a disabled, 24-hour Pages candidate; never execute bundled code.')
    parser.add_argument('--bundle', type=Path, required=True)
    parser.add_argument('--run-metadata', type=Path, required=True)
    parser.add_argument('--artifact-metadata', type=Path, required=True)
    args = parser.parse_args()
    try:
        site = verify_bundle(args.bundle, read_json(args.run_metadata), read_json(args.artifact_metadata))
    except (CandidateError, OSError, TypeError, KeyError) as exc:
        print(f'Pages candidate verification failed ({type(exc).__name__}); no files were executed.', file=sys.stderr)
        return 1
    print(f'Pages candidate integrity and disabled-source verification passed: {len(inventory(site))} files.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
