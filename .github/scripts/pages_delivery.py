from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

if __package__:
    from .verify_pages_candidate import CandidateError, IDENTITY_KEYS, SOURCE_EVENTS, SOURCE_REPOSITORY, read_json, require, timestamp, validate_identity
else:
    from verify_pages_candidate import CandidateError, IDENTITY_KEYS, SOURCE_EVENTS, SOURCE_REPOSITORY, read_json, require, timestamp, validate_identity

POINTER_KEYS = IDENTITY_KEYS | {'schema_version', 'generated_at', 'expires_at', 'youtube_mode', 'artifact_id'}


def numeric_id(value):
    require(isinstance(value, str) and re.fullmatch(r'[1-9][0-9]*', value) is not None, 'Invalid numeric identifier')
    return value


def validate_pointer(pointer, *, now=None):
    require(isinstance(pointer, dict) and set(pointer) == POINTER_KEYS, 'Invalid delivery fields')
    validate_identity({key: pointer[key] for key in IDENTITY_KEYS})
    numeric_id(pointer['artifact_id'])
    require(type(pointer['schema_version']) is int and pointer['schema_version'] == 1 and pointer['youtube_mode'] == 'disabled',
            'Only disabled deliveries are supported')
    generated, expires = timestamp(pointer['generated_at']), timestamp(pointer['expires_at'])
    current = now or datetime.now(timezone.utc)
    require(generated <= current < expires and expires - generated == timedelta(hours=24), 'Delivery expired or has invalid retention')


def make_pointer(manifest, artifact_id):
    require(isinstance(manifest, dict), 'Invalid source manifest')
    pointer = {key: manifest[key] for key in POINTER_KEYS - {'artifact_id'}}
    pointer['artifact_id'] = numeric_id(artifact_id)
    validate_pointer(pointer, now=timestamp(pointer['generated_at']))
    return pointer


def github_api(endpoint):
    require(endpoint.startswith('repos/' + SOURCE_REPOSITORY + '/actions/runs/'), 'Unexpected API endpoint')
    result = subprocess.run(['gh', 'api', endpoint], capture_output=True, text=True, timeout=30)
    if result.returncode:
        raise CandidateError('Source Actions metadata could not be read; credentials were not logged')
    try:
        return json.loads(result.stdout)
    except ValueError as exc:
        raise CandidateError('Invalid source metadata') from exc


def resolve_source(run_id, sha, *, pointer=None, api=github_api, sleep=time.sleep, max_polls=31, now=None):
    numeric_id(run_id)
    require(isinstance(sha, str) and re.fullmatch(r'[a-f0-9]{40}', sha) is not None, 'Invalid commit')
    require(type(max_polls) is int and 1 <= max_polls <= 31, 'Invalid wait budget')
    if pointer is not None:
        validate_pointer(pointer, now=now)
        require(pointer['source_run_id'] == run_id and pointer['source_sha'] == sha, 'Delivery/run mismatch')
    endpoint = 'repos/' + SOURCE_REPOSITORY + '/actions/runs/' + run_id
    for index in range(max_polls):
        run = api(endpoint)
        require(isinstance(run, dict) and run.get('repository', {}).get('full_name') == SOURCE_REPOSITORY, 'Wrong source repository')
        require(str(run.get('id')) == run_id and run.get('head_sha') == sha and run.get('head_branch') == 'master', 'Wrong source run/commit/ref')
        require(run.get('event') in SOURCE_EVENTS.get(run.get('path'), set()), 'Unexpected source workflow/event')
        require(type(run.get('run_attempt')) is int and run['run_attempt'] >= 1, 'Invalid source attempt')
        if pointer is not None:
            require(run['run_attempt'] == pointer['source_run_attempt'], 'Wrong delivery run attempt')
        if run.get('status') == 'completed':
            require(run.get('conclusion') == 'success', 'Source producer failed or was cancelled')
            break
        require(run.get('status') in ('queued', 'in_progress', 'waiting', 'pending', 'requested'), 'Unknown source status')
        if index == max_polls - 1:
            raise CandidateError('Source did not complete within the wait budget')
        sleep(10)
    response = api(endpoint + '/artifacts?per_page=100')
    require(isinstance(response, dict) and type(response.get('total_count')) is int and response['total_count'] <= 100,
            'Unexpected artifact metadata list')
    matches = [item for item in response.get('artifacts', []) if isinstance(item, dict) and item.get('name') == 'pages-candidate']
    require(len(matches) == 1 and matches[0].get('expired') is False, 'Missing, duplicate or expired source artifact')
    artifact = matches[0]
    numeric_id(str(artifact.get('id')))
    if pointer is not None:
        require(str(artifact['id']) == pointer['artifact_id'], 'Wrong delivery artifact')
    source = artifact.get('workflow_run', {})
    require(str(source.get('id')) == run_id and source.get('head_sha') == sha, 'Wrong artifact source identity')
    current = now or datetime.now(timezone.utc)
    created, expires = timestamp(artifact.get('created_at')), timestamp(artifact.get('expires_at'))
    require(created <= current < expires and timedelta(0) < expires - created <= timedelta(hours=24, minutes=5),
            'Source artifact expired or retained too long')
    return run, artifact


def main():
    parser = argparse.ArgumentParser(description='Build or resolve a minimal Pages handoff; never log credentials or execute artifact code.')
    sub = parser.add_subparsers(dest='operation', required=True)
    write = sub.add_parser('write')
    write.add_argument('--manifest', type=Path, required=True)
    write.add_argument('--artifact-id', required=True)
    write.add_argument('--output', type=Path, required=True)
    check = sub.add_parser('check')
    check.add_argument('--delivery', type=Path, required=True)
    check.add_argument('--manifest', type=Path, required=True)
    resolve = sub.add_parser('resolve')
    resolve.add_argument('--delivery', type=Path)
    resolve.add_argument('--run-id')
    resolve.add_argument('--sha')
    resolve.add_argument('--output-dir', type=Path, required=True)
    args = parser.parse_args()
    try:
        if args.operation == 'write':
            pointer = make_pointer(read_json(args.manifest), args.artifact_id)
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(json.dumps(pointer, indent=2) + chr(10), encoding='utf-8')
            print('Wrote a minimal disabled Pages delivery record.')
            return 0
        if args.operation == 'check':
            pointer = read_json(args.delivery)
            validate_pointer(pointer)
            expected = make_pointer(read_json(args.manifest), pointer['artifact_id'])
            require(pointer == expected, 'Downloaded manifest does not match the delivery record')
            print('Downloaded manifest exactly matches the validated delivery pointer.')
            return 0
        require(bool(os.environ.get('GH_TOKEN')), 'SOURCE_ARTIFACT_READ_TOKEN is not configured')
        pointer = read_json(args.delivery) if args.delivery else None
        run_id = pointer['source_run_id'] if pointer else args.run_id
        sha = pointer['source_sha'] if pointer else args.sha
        run, artifact = resolve_source(run_id, sha, pointer=pointer)
        output = args.output_dir
        require(output.is_absolute() and not output.exists(), 'Metadata output must be an absent absolute directory')
        output.mkdir(parents=True)
        (output / 'run.json').write_text(json.dumps(run), encoding='utf-8')
        (output / 'artifact.json').write_text(json.dumps(artifact), encoding='utf-8')
        if pointer is not None:
            (output / 'delivery.json').write_text(json.dumps(pointer), encoding='utf-8')
        if os.environ.get('GITHUB_OUTPUT'):
            with open(os.environ['GITHUB_OUTPUT'], 'a', encoding='utf-8') as file:
                file.write('source_run_id=' + run_id + chr(10) + 'artifact_id=' + str(artifact['id']) + chr(10))
        print('Verified successful source run and short-lived artifact identity.')
        return 0
    except (CandidateError, OSError, TypeError, KeyError, ValueError, subprocess.SubprocessError) as exc:
        print(f'Pages delivery failed ({type(exc).__name__}); credentials and response contents were not logged.', file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
