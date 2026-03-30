from ephaptic.ext.fastapi import Router
from ytmusicapi import YTMusic
from typing import Optional
import syncedlyrics
from yt_dlp import YoutubeDL
from .models import FilterType, SearchResult, AudioStream, ExploreResult

router = Router()

ytmusic = YTMusic()

@router.get('/')
async def music_root():
    return {"status": "ok"}


@router.get('/search')
async def music_search(
    query: str,
    filter: Optional[FilterType] = None,
    limit: int = 20,
) -> list[SearchResult]:
    results = ytmusic.search(query, filter=(filter and filter.value) or None, limit=limit)
    return [res for res in results]

@router.get('/search/suggestions')
async def music_search_suggestions(
    query: str,
) -> list[str]:
    results = ytmusic.get_search_suggestions(query)
    return results

@router.get('/lyrics')
async def music_lyrics(
    query: str,
) -> str | None:
    results = syncedlyrics.search(query)
    return results

@router.get('/stream')
async def music_stream(
    video_id: str,
) -> list[AudioStream]:
    url = f'https://www.youtube.com/watch?v={video_id}'

    opts = {
        'quiet': True,
        'skip_download': True,
    }

    with YoutubeDL(opts) as ytdlp:
        info = ytdlp.extract_info(url, download=False)

    formats = info.get('formats', [])

    formats = [
        f for f in formats
        if f.get('vcodec') == 'none' # we are looking for audio streams only
    ]

    formats.sort(key=lambda x: x.get("abr") or 0, reverse=True)

    return formats

@router.get('/exlore')
async def music_explore() -> ExploreResult:
    results = ytmusic.get_explore()

    for item in results.get('new_releases', []):
        item['resultType'] = 'album'

    if results.get('top_songs') and 'items' in results['top_songs']:
        for item in results['top_songs']['items']:
            item['resultType'] = 'song'

    for item in results.get('top_episodes', []):
        item['resultType'] = 'episode'

    if results.get('trending') and 'items' in results['trending']:
        for item in results['trending']['items']:
            if 'podcast' in item:
                item['resultType'] = 'episode'
            elif item.get('videoType') in ('MUSIC_VIDEO_TYPE_OMV', 'MUSIC_VIDEO_TYPE_UGC'):
                item['resultType'] = 'video'
            else:
                item['resultType'] = 'song'

    for item in results.get('new_videos', []):
        item['resultType'] = 'video'
        if 'videoType' not in item:
            item['videoType'] = 'MUSIC_VIDEO_TYPE_OMV'

    return results