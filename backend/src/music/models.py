from pydantic import AliasChoices, BaseModel, Field, field_validator
from enum import Enum
from typing import (
    Optional,
    Literal,
    Union,
    Annotated,

    List,
)
from urllib.parse import urlsplit, urlunsplit

class AudioStream(BaseModel):
    format_id: str
    ext: Optional[str] = None
    acodec: Optional[str] = None
    abr: Optional[float] = None
    url: str


class FilterType(str, Enum):
    SONGS = "songs"
    VIDEOS = "videos"
    ALBUMS = "albums"
    ARTISTS = "artists"
    PLAYLISTS = "playlists"
    EPISODES = "episodes"

class Thumbnail(BaseModel):
    url: str
    width: int
    height: int

    # @field_validator("url", mode="before")
    # @classmethod
    # def strip_query_params(cls, v: str) -> str:
    #     parts = urlsplit(v)
    #     return urlunsplit((parts.scheme, parts.netloc, parts.path, "", ""))

class Artist(BaseModel):
    name: str
    id: Optional[str] = None

class Podcast(BaseModel):
    name: str
    id: Optional[str] = None

class ResultType(str, Enum):
    ARTIST = "artist"
    SONG = "song"
    ALBUM = "album"
    VIDEO = "video"
    PLAYLIST = "playlist"
    EPISODE = "episode"
    PODCAST = "podcast"

class BaseResult(BaseModel):
    category: Optional[str] = None
    resultType: ResultType
    thumbnails: List[Thumbnail]

class ArtistResult(BaseResult):
    resultType: Literal[ResultType.ARTIST]
    # note: artist results are inconsistent in the yt music api - some have 'artists' list but others have 'artist' string
    artist: Optional[str] = None
    artists: Optional[List[Artist]] = None
    subscribers: Optional[str] = None # str because its already in UI-ready format (e.g. has "K" at the end)
    shuffleId: Optional[str] = None
    radioId: Optional[str] = None
    browseId: Optional[str] = None

class SongResult(BaseResult):
    resultType: Literal[ResultType.SONG]
    title: str
    videoId: str
    videoType: str
    artists: List[Artist]
    album: Optional[Artist] = None
    duration: Optional[str] = None
    duration_seconds: Optional[int] = None
    year: Optional[str] = None
    views: Optional[str] = None
    isExplicit: Optional[bool] = None
    inLibrary: Optional[bool] = None
    pinnedToListenAgain: Optional[bool] = None
    playlistId: Optional[str] = None
    rank: Optional[str] = None
    trend: Optional[str] = None

class VideoResult(BaseResult):
    resultType: Literal[ResultType.VIDEO]
    title: str
    videoId: str
    videoType: Optional[str] = None
    artists: List[Artist]
    views: Optional[str] = None
    duration: Optional[str] = None
    duration_seconds: Optional[int] = None
    year: Optional[str] = None
    playlistId: Optional[str] = None

class AlbumResult(BaseResult):
    resultType: Literal[ResultType.ALBUM]
    title: str
    type: Optional[str] = None
    artists: List[Artist]
    playlistId: str = Field(validation_alias=AliasChoices('playlistId', 'audioPlaylistId'))
    browseId: Optional[str] = None
    year: Optional[str] = None
    isExplicit: Optional[bool] = None
    duration: Optional[str] = None

class PlaylistResult(BaseResult):
    resultType: Literal[ResultType.PLAYLIST]
    title: str
    author: Optional[Union[List[Artist], str]] = None
    itemCount: Optional[Union[int, str]] = None # could be .. "212" or .. "95K" we can't tell :/
    browseId: Optional[str] = None
    playlistId: Optional[str] = None

class EpisodeResult(BaseResult):
    resultType: Literal[ResultType.EPISODE]
    title: str
    videoId: str
    videoType: str
    date: Optional[str] = None
    live: Optional[bool] = None
    podcast: Optional[Podcast] = None

class PodcastResult(BaseResult):
    resultType: Literal[ResultType.PODCAST]
    title: str
    browseId: str

SearchResult = Annotated[
    Union[
        ArtistResult,
        SongResult,
        VideoResult,
        AlbumResult,
        PlaylistResult,
        EpisodeResult,
        PodcastResult,
    ],
    Field(discriminator="resultType")
]

class TopSongsResult(BaseModel):
    playlist: str
    items: list[SearchResult]

class TrendingResult(BaseModel):
    playlist: str
    items: list[SearchResult]

class MoodOrGenre(BaseModel):
    title: str
    params: str

class ExploreResult(BaseModel):
    new_releases: Optional[list[SearchResult]] = None
    top_songs: Optional[TopSongsResult] = None
    moods_and_genres: Optional[list[MoodOrGenre]] = None
    top_episodes: Optional[list[EpisodeResult]] = None
    trending: Optional[TrendingResult] = None
    new_videos: Optional[list[SearchResult]] = None