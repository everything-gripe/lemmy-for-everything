import {
    Comment,
    CommentIds,
    Everything,
    GetGroupOptions,
    GetGroupResult,
    GetNestedCommentsOptions,
    GetNestedCommentsResult,
    GetPostOptions,
    GetPostResult,
    GetPostsOptions,
    GetPostsResult,
    GetUserDetailsOptions,
    GetUserDetailsResult,
    GetUserOptions,
    IService, GetUserResult,
    Unimplemented,
    Kind,
    Post,
    Group,
    User,
    UserDetail, SearchResult, SearchOptions, SearchType, AutocompleteOptions, AutocompleteResult, Data
} from "everything-sdk";
import {
    CommentSortType,
    CommentView,
    CommunityView,
    LemmyHttp,
    PersonView,
    PostView,
    SortType,
    SearchType as LemmySearchType,
    Community as LemmyCommunity,
    Person as LemmyPerson,
    Post as LemmyPost, SearchResponse
} from "lemmy-js-client";

const maxQuery = 50

type SearchResponseTypes = LemmyCommunity | LemmyPerson | LemmyPost
type SearchTypes = CommunitySearchType | UserSearchType | PostSearchType


interface InputInfo  {
    primaryInput: string,
    inputAtInstance: string | undefined,
    instance: string,
    postId: string
}

type Filters = {
    limit: number,
    page: number
    sort?: SortType
    primarySort?: string
}

type CommentFilters = {
    limit: number,
    sort?: CommentSortType
}

type AutocompleteFilters = {
    limit: number,
    q: string,
    searchType: ISearchTypeConstructor
}

type SearchFilters = {
    limit: number,
    page: number,
    q: string,
    searchType: ISearchTypeConstructor
}

interface ISearchTypeConstructor {
    new (lemmyService: LemmyService, searchResponse: SearchResponse): SearchTypes
    searchTypeName: LemmySearchType
}

interface ISearchType<T extends SearchResponseTypes, TData extends Data> {
    filterResults(predicate?: (result: T) => boolean): this
    buildResults(): Promise<Array<Everything<TData>>>
}

abstract class SearchTypeBase<T extends SearchResponseTypes, TData extends Data> implements ISearchType<T, TData> {
    readonly lemmyService: LemmyService
    readonly searchResponse: SearchResponse

    constructor(lemmyService: LemmyService, searchResponse: SearchResponse) {
        this.lemmyService = lemmyService
        this.searchResponse = searchResponse
    }

    // filterResults(predicate?: (result: T) => boolean, )

    abstract filterResults(predicate?: (result: T) => boolean): this;

    abstract buildResults(): Promise<Array<Everything<TData>>>;
}

const CommunitySearchTypeBase = SearchTypeBase<LemmyCommunity, Group>
const UserSearchTypeBase = SearchTypeBase<LemmyPerson, User>
const PostSearchTypeBase = SearchTypeBase<LemmyPost, Post>


class CommunitySearchType extends CommunitySearchTypeBase {
    static readonly searchTypeName: LemmySearchType = "Communities"

    filterResults(predicate?: (result: LemmyCommunity) => boolean): this {
        //TODO: Consider moving much of this logic to the base
        this.searchResponse.communities = predicate
        ? this.searchResponse.communities.filter(communityView => predicate(communityView.community))
        : this.searchResponse.communities

        return this
    }

    async buildResults(): Promise<Array<Everything<Group>>> {
        return this.searchResponse.communities.map(group => this.lemmyService.buildGroup(group))
    }
}

class UserSearchType extends UserSearchTypeBase {
    static readonly searchTypeName: LemmySearchType = "Users"

    filterResults(predicate?: (result: LemmyPerson) => boolean): this {
        this.searchResponse.users = predicate
        ? this.searchResponse.users.filter(personView => predicate(personView.person))
        : this.searchResponse.users

        return this
    }

    async buildResults(): Promise<Array<Everything<User>>> {
        return this.searchResponse.users.map(user => this.lemmyService.buildUser(user))
    }
}

class PostSearchType extends PostSearchTypeBase {
    static readonly searchTypeName: LemmySearchType = "Posts"

    filterResults(predicate?: (result: LemmyPost) => boolean): this {
        this.searchResponse.posts = predicate
        ? this.searchResponse.posts.filter(postView => predicate(postView.post))
        : this.searchResponse.posts

        return this
    }

    async buildResults(): Promise<Array<Everything<Post>>> {
        return await Promise.all(this.searchResponse.posts.map(post => this.lemmyService.buildPost(post)))
    }
}

const searchTypes: {[key in SearchType]: ISearchTypeConstructor} = {
    [SearchType.Group]: CommunitySearchType,
    [SearchType.User]: UserSearchType,
    [SearchType.Post]: PostSearchType
}


const kbin = 'kbin.social';

export default class LemmyService implements IService {
    readonly defaultInstance = process.env.LEMMY_DEFAULT_INSTANCE!
    readonly kbinDefaultInstance = process.env.LEMMY_DEFAULT_INSTANCE!

    client?: LemmyHttp
    inputInfo?: InputInfo

    setClient(input = '', {ids, group}: {ids?: CommentIds, group?: string} = {}): this is {client: LemmyHttp, inputInfo: InputInfo} {
        const [primaryInput, inputInstance] = input.split('@')
        const [postId, postInstance] = ids?.postId.split('@') || []
        const [groupName, groupInstance] = group?.split('@') || []

        const instance = (postId ? postInstance : groupInstance || inputInstance)
        const instanceOrDefault = instance || this.defaultInstance
        const connectionInstance = instanceOrDefault === kbin ?  this.kbinDefaultInstance : instanceOrDefault

        const inputAtInstance = primaryInput ? `${primaryInput}@${instanceOrDefault}` : undefined

        this.client = new LemmyHttp(`https://${connectionInstance}`)
        this.inputInfo = {primaryInput, inputAtInstance, instance, postId}

        return true
    }

    async getGroup({group}: GetGroupOptions): Promise<GetGroupResult> {
        if(!this.setClient(group)) return new Unimplemented()

        const communityResponse = await this.client.getCommunity({
            name: this.inputInfo.inputAtInstance
        })

        return this.buildGroup(communityResponse.community_view, group);
    }


    async autocomplete({limit, query, searchType}: AutocompleteOptions): Promise<AutocompleteResult> {
        if(this.defaultInstance == kbin || !this.setClient(query)) return new Unimplemented()

        //TODO: Consider combining with similar function below
        //TODO: Consder using type_ "All" when more than one type is available.
        const search = async ({searchType, ...filters}: AutocompleteFilters) => {
            const searchResponse = await this.client!.search({
                type_: searchType!.searchTypeName,
                listing_type: this.inputInfo!.instance ? "Local" : "All",
                sort: "TopAll",
                ...filters
            })

            return new searchType!(this, searchResponse)
                .filterResults(result => result.name.toLowerCase().startsWith(filters.q!.toLowerCase()))
                .buildResults()
        }

        let filters = processAutocompleteFilters(limit, this.inputInfo.primaryInput, searchType)
        const results: Array<Everything> = []

        if (!Array.isArray(filters)) {
            filters = [filters]
        }

        for (const result of filters.map(search)) {
            results.push(...await result);
        }

        return Everything.list({
            dist: results.length,
            children: results
        })
    }

    async search({group, query, exact, limit, page, sort, secondarySort, searchType, searchInGroup}: SearchOptions): Promise<SearchResult> {
        if(this.defaultInstance == kbin || !this.setClient(query, {group})) return new Unimplemented()

        const search = async ({searchType, ...filters}: SearchFilters) => {
            const searchResponse = await this.client!.search({
                community_name: searchInGroup ? group : undefined,
                type_: searchType!.searchTypeName,
                // listing_type: this.inputInfo!.instance ? "Local" : "All",
                sort: "TopAll",
                ...filters
            })

            return new searchType!(this, searchResponse)
                .filterResults(result => exact
                    ? result.name.toLowerCase() === filters.q!.toLowerCase()
                    : true)
                .buildResults()
        }

        let filters = processSearchFilters(limit, page, sort, secondarySort, exact, this.inputInfo.primaryInput, searchType)

        const results: Array<Everything> = []

        if (!Array.isArray(filters)) {
            filters = [filters]
        }

        for (const result of filters.map(search)) {
            results.push(...await result);
        }

        return Everything.list({
            dist: results.length,
            children: results
        })
    }

    async getNestedComments({ids, limit, depth, sort, group}: GetNestedCommentsOptions): Promise<GetNestedCommentsResult> {
        const filters = processCommentFilters(limit, sort);

        const post = await this.getPost({id: ids.postId, group})
        if (post instanceof Unimplemented) return new Unimplemented()

        if(!this.setClient(group, {ids})) return new Unimplemented()

        const commentsResponse = await this.client.getComments({
            post_id: Number(this.inputInfo.postId),
            parent_id: ids.commentId ? Number(ids.commentId) : undefined,
            type_: "All",
            max_depth: depth,
            ...filters
        })

        const nestedComments = this.nestComments(ids, commentsResponse.comments)
        // const everythingPost = post.data.children[0].data
        //
        // const more = everythingPost.num_comments - commentsResponse.comments.length
        // if (more > 0) {
        //     nestedComments.push(Everything.moreComments({
        //         parent_id: everythingPost.id,
        //         depth: 0,
        //         id: everythingPost.parent_id,
        //         name: `${Kind.MoreComments}_more`,
        //         count: more,
        //         children: ['more']
        //     }))
        // }

        return [
            Everything.list({
                dist: 1,
                children: [post],
            }),
            Everything.list({
                children: nestedComments,
            })
        ]
    }

    async getPost({id, group}: GetPostOptions): Promise<GetPostResult> {
        if(!this.setClient(group, {ids: {postId: id}})) return new Unimplemented()

        const postResponse = await this.client.getPost({
            id: Number(this.inputInfo.postId)
        })

        return await this.buildPost(postResponse.post_view)
    }

    async getPosts({limit, page, sort, secondarySort, group}: GetPostsOptions): Promise<GetPostsResult> {
        const {primarySort, ...filters} = processFilters(limit, page, sort, secondarySort);

        if (!this.setClient(group)) return new Unimplemented()
        if (this.defaultInstance === kbin && !this.inputInfo.inputAtInstance) return new Unimplemented()

        const postsResponse = await this.client.getPosts({
            community_name: this.inputInfo.inputAtInstance,
            type_: "All",
            ...filters
        })

        const posts = await Promise.all(postsResponse.posts.map(this.buildPost))

        return Everything.list({
            after: posts.length ? (filters.page + 1).toString() : null,
            dist: posts.length,
            children: posts,
            before: filters.page > 1 ? (filters.page - 1).toString() : null
        });
    }

    async getUser({username}: GetUserOptions): Promise<GetUserResult> {
        if(!this.setClient(username)) return new Unimplemented()

        const personDetailsResponse = await this.client.getPersonDetails({
            username: this.inputInfo.inputAtInstance,
            limit: 0
        })

        return this.buildUser(personDetailsResponse.person_view);
    }

    async getUserDetails({limit, page, sort, secondarySort, userDetail, username}: GetUserDetailsOptions): Promise<GetUserDetailsResult> {
        const {primarySort, ...filters} = processFilters(limit, page, sort, secondarySort);

        if(!this.setClient(username)) return new Unimplemented()

        const personDetailsResponse = await this.client.getPersonDetails({
            username: this.inputInfo.inputAtInstance,
            ...filters
        })

        const posts = personDetailsResponse.posts
        const comments = personDetailsResponse.comments

        switch (userDetail) {
            case UserDetail.Comments:
                return Everything.list({
                    after: comments.length ? (filters.page + 1).toString() : null,
                    dist: comments.length,
                    children: comments.map(this.buildComment),
                    before: filters.page > 1 ? (filters.page - 1).toString() : null
                })
            case UserDetail.Submitted:
                return Everything.list({
                    after: posts.length ? (filters.page + 1).toString() : null,
                    dist: posts.length,
                    children: await Promise.all(posts.map(this.buildPost)),
                    before: filters.page > 1 ? (filters.page - 1).toString() : null
                })
            case UserDetail.Overview:
                const details = [...await Promise.all(posts.map(this.buildPost)), ...comments.map(this.buildComment)]
                switch (primarySort || 'New') {
                    case 'New':
                        details.sort((left, right) => right.data.created_utc! - left.data.created_utc!)
                        break
                    case 'Old':
                        details.sort((left, right) => left.data.created_utc! - right.data.created_utc!)
                        break
                    case 'Top':
                        details.sort((left, right) => right.data.score! - left.data.score!)
                        break
                    case 'Hot':
                        // @ts-ignore
                        details.sort((left, right) => right.data.hot_rank! - left.data.hot_rank)
                        break
                }

                return Everything.list<Post|Comment>({
                    after: details.length ? (filters.page + 1).toString() : null,
                    dist: details.length,
                    children: details,
                    before: filters.page > 1 ? (filters.page - 1).toString() : null
                })
            default:
                return new Unimplemented()
        }
    }


    buildPost = async (postView: PostView): Promise<Everything<Post>> => {
        const id= this.inputAtNonDefaultInstance(postView.post.id.toString(), this.inputInfo!.instance)
        const title = postView.post.name;
        const postSubreddit = this.inputAtNonDefaultInstance(postView.community.name, new URL(postView.community.actor_id).host)
        const subredditNamePrefixed = `r/${postSubreddit}`
        const numComments = postView.counts.comments
        const permalink = `/r/${postSubreddit}/comments/${id}`
        const author = this.inputAtNonDefaultInstance(postView.creator.name, new URL(postView.creator.actor_id).host)
        const authorFullname = `${Kind.User}_${postView.creator.id}`
        const ups = postView.counts.upvotes
        const downs = postView.counts.downvotes
        const score = postView.counts.score
        const createdUtc = Math.floor(new Date(postView.post.published).getTime() / 1000)
        const name = `${Kind.Post}_${id}`
        const pinned = postView.post.featured_local || postView.post.featured_community
        const url = postView.post.url || `https://lemmy.z.gripe${permalink}`
        const domain = postView.post.url ? new URL(url).hostname : `self.${postSubreddit}`
        const selftext = postView.post.body
        const isSelf = !!selftext

        const hotRank = postView.counts.hot_rank


        const post = Everything.post({
            id: id,
            title: title || '',
            name: name,
            url: url,
            subreddit: postSubreddit,
            subreddit_name_prefixed: subredditNamePrefixed,
            num_comments: numComments,
            permalink: permalink,
            author: author,
            author_fullname: authorFullname,
            ups: ups,
            downs: downs,
            score: score,
            created: createdUtc,
            created_utc: createdUtc,
            is_self: isSelf,
            selftext: selftext || '',
            selftext_html: selftext || '',
            pinned: pinned,
            stickied: pinned,
            domain: domain,
            //For sorting after the fact
            // @ts-ignore
            hot_rank: hotRank
        })
        await post.data.buildMetadata()
        return post
    };

    buildComment = (commentView: CommentView): Everything<Comment> => {
        const id = commentView.comment.id.toString()
        const parentId = getParentId(commentView)
        const postId = this.inputAtNonDefaultInstance(commentView.post.id.toString(), this.inputInfo!.instance)
        const postSubreddit = this.inputAtNonDefaultInstance(commentView.community.name, new URL(commentView.community.actor_id).host)
        const subredditNamePrefixed = `r/${postSubreddit}`
        const author = this.inputAtNonDefaultInstance(commentView.creator.name, new URL(commentView.creator.actor_id).host)
        const authorFullname = `${Kind.User}_${commentView.creator.id}`
        const ups = commentView.counts.upvotes
        const downs = commentView.counts.downvotes
        const score = commentView.counts.score
        const createdUtc = Math.floor(new Date(commentView.comment.published).getTime() / 1000)
        const body = commentView.comment.content
        const linkId = `${Kind.Post}_${postId}`;
        const name = `${Kind.Comment}_${id}`
        // const count = commentView.counts.child_count
        const depth = commentView.comment.path.split('.').length - 2
        const permalink = `/r/${postSubreddit}/comments/${postId}/_/${id}/`
        const distinguished = commentView.comment.distinguished
        const hotRank = commentView.counts.hot_rank

        return Everything.comment({
            id: id,
            link_id: linkId,
            name: name,
            parent_id: parentId ? `${Kind.Comment}_${parentId}` : linkId,
            subreddit: postSubreddit,
            subreddit_name_prefixed: subredditNamePrefixed,
            author: author,
            author_fullname: authorFullname,
            ups: ups,
            downs: downs,
            score: score,
            created_utc: createdUtc,
            created: createdUtc,
            body: body,
            body_html: body,
            // count: count || undefined,
            depth: depth,
            permalink: permalink,
            stickied: distinguished,
            //For sorting after the fact
            // @ts-ignore
            hot_rank: hotRank
        })
    };

    buildGroup = (communityView: CommunityView, subreddit?: string): Everything<Group> => {
        const createdUtc = Math.floor(new Date(communityView.counts.published).getTime() / 1000);
        const displayName = subreddit || this.inputAtNonDefaultInstance(communityView.community.name, new URL(communityView.community.actor_id).host)

        return Everything.group({
            name: `${Kind.Group}_${communityView.community.id}`,
            display_name: displayName,
            display_name_prefixed: `r/${displayName}`,
            title: communityView.community.name,
            id: communityView.community.id.toString(),
            subscribers: communityView.counts.subscribers,
            accounts_active: communityView.counts.users_active_day,
            active_user_count: communityView.counts.users_active_month,
            created: createdUtc,
            created_utc: createdUtc,
            community_icon: communityView.community.icon,
            icon_img: communityView.community.icon,
            banner_img: communityView.community.banner,
            banner_background_image: communityView.community.banner,
            mobile_banner_image: communityView.community.banner,
            description: communityView.community.description,
            description_html: communityView.community.description,
            public_description: communityView.community.description,
            public_description_html: communityView.community.description,
            over18: communityView.community.nsfw,
        })
    };

    buildUser = (personView: PersonView): Everything<User> => {
        const createdUtc = Math.floor(new Date(personView.person.published).getTime() / 1000);
        const displayName = this.inputAtNonDefaultInstance(personView.person.name, new URL(personView.person.actor_id).host)
        return Everything.user({
            icon_img: personView.person.avatar,
            name: displayName,
            id: personView.person.id.toString(),
            total_karma: personView.counts.post_score + personView.counts.comment_score,
            link_karma: personView.counts.post_score,
            comment_karma: personView.counts.comment_score,
            created_utc: createdUtc,
            created: createdUtc,
            subreddit: {
                name: `${Kind.Group}_${personView.person.id}`,
                display_name: `u_${displayName}`,
                display_name_prefixed: `u/${displayName}`,
                description: personView.person.bio,
                public_description: personView.person.bio,
                subreddit_type: 'user',
                url: `/user/${displayName}`,
                icon_img: personView.person.avatar,
                title: personView.person.display_name,
                banner_img: personView.person.banner,
            }
        })
    };

    nestComments = (ids: CommentIds, flatComments: CommentView[]): Array<Everything<Comment>> => {
        let rootId
        const comments: {[key: string]: Array<{commentView: CommentView, everythingComment: Everything<Comment>}>} = {}

        for (const commentView of flatComments) {
            const parentId = getParentId(commentView);
            comments[parentId] ??= [];
            comments[parentId].push({commentView, everythingComment: this.buildComment(commentView)})

            if (commentView.comment.id.toString() === ids.commentId) {
                rootId = parentId
            }
        }

        for (const commentId in comments) {
            for (const container of comments[commentId]) {
                const replies = comments[container.commentView.comment.id] || []
                // const more = container.commentView.counts.child_count - replies.length
                // if (more > 0) {
                //     replies.push(Everything.moreComments({
                //         parent_id: container.everythingComment.data.id,
                //         depth: container.everythingComment.data.depth + 1,
                //         id: container.everythingComment.data.id,
                //         name: `${Kind.Comment}_more`,
                //         count: more,
                //         children: ['more']
                //     }))
                // }
                if (replies.length) {
                    container.everythingComment.data.replies = Everything.list({
                        children: replies.map(container => container.everythingComment),
                    })
                }
            }
        }

        return comments[rootId || '0']?.map(container => container.everythingComment) ?? [];
    };


    inputAtNonDefaultInstance = (input: string, instance: string) => instance && instance !== this.defaultInstance ? `${input}@${instance}` : input
}

function processFilters(limit: number, page: string | undefined, sort: string | undefined, secondarySort: string | undefined): Filters {
    const pageNumber = Number(page || 1)

    let primarySort
    if (sort) {
        primarySort = capitalizeFirstLetter(sort.toLowerCase())
        sort = `${primarySort}${secondarySort ? capitalizeFirstLetter(secondarySort.toLowerCase()) : ''}`
        sort = sortTypes.includes(sort) ? sort : sortTypes.includes(primarySort) ? primarySort : undefined
    }
    return {
        limit,
        page: pageNumber,
        sort: sort as SortType,
        primarySort
    };
}

function processCommentFilters(limit: number, sort: string | undefined): CommentFilters {
    limit = Math.min(limit, maxQuery)

    if (sort) {
        sort = capitalizeFirstLetter(sort.toLowerCase())
        sort = commentSortTypes.includes(sort) ? sort : undefined
    }

    return {
        limit,
        sort: sort as CommentSortType
    };
}


function processSearchTypeFilters(filters: any, searchType: SearchType | Array<SearchType> | SearchType.Group | SearchType.Post | SearchType.User) {
    const createFilter = (searchType: SearchType) => ({
        ...filters,
        searchType: searchTypes[searchType]
    })

    return Array.isArray(searchType)
        ? searchType.map(createFilter)
        : createFilter(searchType)
}

function processSearchFilters(limit: number, page: string | undefined, sort: string | undefined, secondarySort: string | undefined, exact: boolean | undefined, query: string, searchType: SearchType | Array<SearchType>): SearchFilters | Array<SearchFilters>  {
    limit = exact ? Math.min(estimateSearchLimit(limit, query), maxQuery) : Math.min(limit, maxQuery)
    const filters = {q: query, ...processFilters(limit, page, sort, secondarySort)}
    return processSearchTypeFilters(filters, searchType);
}



function processAutocompleteFilters(limit: number, query: string, searchType: SearchType | Array<SearchType>): AutocompleteFilters | Array<AutocompleteFilters> {
    limit = Math.min(estimateSearchLimit(limit, query), maxQuery)
    const filters = {limit, q: query}
    return processSearchTypeFilters(filters, searchType)
}


function estimateSearchLimit(autocompleteLimit: number, query: string, scalingFactor = 8) {
    const maxQueryLength = 25;
    const normalizedQueryLength = query.length / maxQueryLength;
    const inverseNormalizedQueryLength = 1 - normalizedQueryLength;
    return Math.max(autocompleteLimit, Math.round(autocompleteLimit * (1 + inverseNormalizedQueryLength * scalingFactor)));
}

function getParentId(commentView: CommentView): number {
    const pathSegments = commentView.comment.path.split('.')
    return Number(pathSegments[pathSegments.length - 2]);
}

function capitalizeFirstLetter(str: string): string {
    if (str.length === 0) {
        return str
    }

    const firstChar = str.charAt(0).toUpperCase()
    const restOfString = str.slice(1)

    return firstChar + restOfString
}

// export function buildHtmlRedirect(path) {
//     if (path.matches)
// }

// export async function getMoreNestedComments({ids, limit, depth, sort, subreddit}) {
//
// }

const sortTypes = ["Active", "Hot", "New", "Old", "TopDay", "TopWeek", "TopMonth", "TopYear", "TopAll", "MostComments", "NewComments", "TopHour", "TopSixHour", "TopTwelveHour", "TopThreeMonths", "TopSixMonths", "TopNineMonths"]

const commentSortTypes = ["Hot", "Top", "New", "Old"]
