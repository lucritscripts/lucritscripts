// Lucrit Script — library data
// Each entry is a real, runnable Luau module. Edit / append freely.

export const CATEGORIES = [
  { id: "combat",    label: "Combat",    hue: 0,   accent: "#ff4d5e" },
  { id: "ui",        label: "UI",        hue: 190, accent: "#39d7ff" },
  { id: "npc",       label: "NPC",       hue: 265, accent: "#a97bff" },
  { id: "admin",     label: "Admin",     hue: 35,  accent: "#ffb547" },
  { id: "data",      label: "Data",      hue: 150, accent: "#2fe0a6" },
  { id: "tycoon",    label: "Tycoon",    hue: 48,  accent: "#ffd75e" },
  { id: "inventory", label: "Inventory", hue: 210, accent: "#5aa9ff" },
  { id: "shops",     label: "Shops",     hue: 320, accent: "#ff6fd8" },
  { id: "utilities", label: "Utilities", hue: 200, accent: "#8fa6c2" },
  { id: "movement",  label: "Movement",  hue: 165, accent: "#4ff0d0" },
  { id: "animation", label: "Animation", hue: 285, accent: "#c98bff" },
  { id: "other",     label: "Other",     hue: 220, accent: "#9fb2cc" },
];

export const SORTS = [
  { id: "popular", label: "Most Popular" },
  { id: "newest",  label: "Newest" },
  { id: "rated",   label: "Highest Rated" },
  { id: "viewed",  label: "Most Viewed" },
];

/* ------------------------------------------------------------------ */

export const SCRIPTS = [
  {
    id: "combat-system",
    title: "Combat System",
    category: "combat",
    desc: "Server-authoritative melee with cooldowns, hit validation and damage falloff. Rejects client-claimed hits outside range.",
    author: "lucrit",
    rating: 4.9, views: 184203, copies: 41288, added: "2026-07-28", featured: true,
    tags: ["melee", "server", "anti-cheat"],
    code: `--!strict
-- CombatSystem (ServerScriptService)
-- Server decides every hit. The client only *requests* a swing.

local Players = game:GetService("Players")
local RS = game:GetService("ReplicatedStorage")
local Debris = game:GetService("Debris")

local SwingRemote = RS:WaitForChild("Swing") :: RemoteEvent

local CONFIG = {
    Cooldown   = 0.55,
    Range      = 9,
    BaseDamage = 22,
    Falloff    = 0.45,  -- damage kept at max range
    ArcDegrees = 110,
}

local lastSwing: {[Player]: number} = {}

local function inArc(origin: CFrame, target: Vector3): boolean
    local to = (target - origin.Position)
    local flat = Vector3.new(to.X, 0, to.Z)
    if flat.Magnitude < 0.01 then return true end
    local dot = origin.LookVector.Unit:Dot(flat.Unit)
    return math.deg(math.acos(math.clamp(dot, -1, 1))) <= CONFIG.ArcDegrees / 2
end

local function damageFor(distance: number): number
    local t = math.clamp(distance / CONFIG.Range, 0, 1)
    return CONFIG.BaseDamage * (1 - t * (1 - CONFIG.Falloff))
end

SwingRemote.OnServerEvent:Connect(function(player)
    local now = os.clock()
    if now - (lastSwing[player] or 0) < CONFIG.Cooldown then return end
    lastSwing[player] = now

    local char = player.Character
    local root = char and char:FindFirstChild("HumanoidRootPart") :: BasePart?
    if not root then return end

    for _, other in Players:GetPlayers() do
        if other == player then continue end
        local oc = other.Character
        local oh = oc and oc:FindFirstChildOfClass("Humanoid")
        local orp = oc and oc:FindFirstChild("HumanoidRootPart") :: BasePart?
        if not (oh and orp) or oh.Health <= 0 then continue end

        local dist = (orp.Position - root.Position).Magnitude
        if dist > CONFIG.Range then continue end
        if not inArc(root.CFrame, orp.Position) then continue end

        oh:TakeDamage(damageFor(dist))

        local hit = Instance.new("Attachment")
        hit.Name = "HitMarker"
        hit.Parent = orp
        Debris:AddItem(hit, 0.5)
    end
end)

Players.PlayerRemoving:Connect(function(p) lastSwing[p] = nil end)`,
  },

  {
    id: "hitbox-detection",
    title: "Hitbox Detection",
    category: "combat",
    desc: "Spatial-query hitboxes using GetPartBoundsInBox with an overlap filter. No hidden parts, no touched events.",
    author: "voxelnine",
    rating: 4.7, views: 96420, copies: 20114, added: "2026-06-14",
    tags: ["hitbox", "overlapparams"],
    code: `--!strict
-- Hitbox: allocation-light spatial query hitbox.

local Hitbox = {}
Hitbox.__index = Hitbox

export type Hitbox = typeof(setmetatable({} :: {
    size: Vector3,
    params: OverlapParams,
    hitThisSwing: {[Model]: boolean},
}, Hitbox))

function Hitbox.new(size: Vector3, ignore: {Instance}): Hitbox
    local params = OverlapParams.new()
    params.FilterType = Enum.RaycastFilterType.Exclude
    params.FilterDescendantsInstances = ignore
    params.MaxParts = 24

    return setmetatable({
        size = size,
        params = params,
        hitThisSwing = {},
    }, Hitbox)
end

-- Returns every *new* humanoid found inside the box this swing.
function Hitbox:Query(cf: CFrame): {Humanoid}
    local found: {Humanoid} = {}
    local parts = workspace:GetPartBoundsInBox(cf, self.size, self.params)

    for _, part in parts do
        local model = part:FindFirstAncestorOfClass("Model")
        if not model or self.hitThisSwing[model] then continue end

        local hum = model:FindFirstChildOfClass("Humanoid")
        if hum and hum.Health > 0 then
            self.hitThisSwing[model] = true
            table.insert(found, hum)
        end
    end

    return found
end

function Hitbox:Reset()
    table.clear(self.hitThisSwing)
end

return Hitbox`,
  },

  {
    id: "weapon-handler",
    title: "Weapon Handler",
    category: "combat",
    desc: "Tool lifecycle wrapper — equip, activate, reload and ammo state kept in one place instead of scattered across tools.",
    author: "raxen",
    rating: 4.5, views: 51330, copies: 11902, added: "2026-05-02",
    tags: ["tool", "ammo"],
    code: `--!strict
-- WeaponHandler: attach to a Tool. Handles ammo + reload timing.

local Weapon = {}
Weapon.__index = Weapon

function Weapon.new(tool: Tool, stats: {magazine: number, reloadTime: number, fireRate: number})
    local self = setmetatable({
        tool = tool,
        stats = stats,
        ammo = stats.magazine,
        reloading = false,
        lastShot = 0,
        connections = {} :: {RBXScriptConnection},
    }, Weapon)

    table.insert(self.connections, tool.Activated:Connect(function()
        self:Fire()
    end))
    table.insert(self.connections, tool.Unequipped:Connect(function()
        self.reloading = false
    end))

    return self
end

function Weapon:CanFire(): boolean
    if self.reloading then return false end
    if self.ammo <= 0 then return false end
    return os.clock() - self.lastShot >= 1 / self.stats.fireRate
end

function Weapon:Fire()
    if not self:CanFire() then
        if self.ammo <= 0 then self:Reload() end
        return
    end
    self.lastShot = os.clock()
    self.ammo -= 1
    self.tool:SetAttribute("Ammo", self.ammo)
end

function Weapon:Reload()
    if self.reloading or self.ammo == self.stats.magazine then return end
    self.reloading = true

    task.delay(self.stats.reloadTime, function()
        if not self.reloading then return end
        self.ammo = self.stats.magazine
        self.tool:SetAttribute("Ammo", self.ammo)
        self.reloading = false
    end)
end

function Weapon:Destroy()
    for _, c in self.connections do c:Disconnect() end
    table.clear(self.connections)
end

return Weapon`,
  },

  {
    id: "ragdoll-death",
    title: "Ragdoll On Death",
    category: "combat",
    desc: "Swaps Motor6Ds for BallSocketConstraints the moment health hits zero. Works with R6 and R15.",
    author: "mono",
    rating: 4.6, views: 73810, copies: 17440, added: "2026-04-19",
    tags: ["ragdoll", "physics"],
    code: `--!strict
-- RagdollOnDeath (ServerScriptService)

local Players = game:GetService("Players")

local function ragdoll(character: Model)
    local hum = character:FindFirstChildOfClass("Humanoid")
    if not hum then return end

    hum:ChangeState(Enum.HumanoidStateType.Physics)
    hum.PlatformStand = true

    for _, motor in character:GetDescendants() do
        if not motor:IsA("Motor6D") then continue end

        local a0 = Instance.new("Attachment")
        local a1 = Instance.new("Attachment")
        a0.CFrame = motor.C0
        a1.CFrame = motor.C1
        a0.Parent = motor.Part0
        a1.Parent = motor.Part1

        local socket = Instance.new("BallSocketConstraint")
        socket.Attachment0 = a0
        socket.Attachment1 = a1
        socket.LimitsEnabled = true
        socket.TwistLimitsEnabled = true
        socket.UpperAngle = 45
        socket.Parent = motor.Part0

        motor:Destroy()
    end
end

local function onCharacter(character: Model)
    local hum = character:WaitForChild("Humanoid") :: Humanoid
    hum.BreakJointsOnDeath = false
    hum.Died:Once(function() ragdoll(character) end)
end

Players.PlayerAdded:Connect(function(player)
    player.CharacterAdded:Connect(onCharacter)
    if player.Character then onCharacter(player.Character) end
end)`,
  },

  {
    id: "dialogue-system",
    title: "Dialogue System",
    category: "ui",
    desc: "Branching dialogue with typewriter reveal, choice buttons and skip-to-full-line. Data-driven from a plain table.",
    author: "lucrit",
    rating: 4.8, views: 142905, copies: 33517, added: "2026-07-11", featured: true,
    tags: ["dialogue", "typewriter", "branching"],
    code: `--!strict
-- DialogueSystem (LocalScript inside a ScreenGui)

local TweenService = game:GetService("TweenService")
local gui = script.Parent
local frame = gui:WaitForChild("DialogueFrame")
local label = frame:WaitForChild("Text") :: TextLabel
local choices = frame:WaitForChild("Choices") :: Frame

export type Node = {
    text: string,
    options: {{ label: string, goto: string? }}?,
}

local Dialogue = {}
local typing = false
local skipRequested = false

local function typewrite(text: string, cps: number)
    typing = true
    skipRequested = false
    label.Text = ""

    for i = 1, #text do
        if skipRequested then
            label.Text = text
            break
        end
        label.Text = string.sub(text, 1, i)
        task.wait(1 / cps)
    end

    typing = false
end

function Dialogue.Skip()
    if typing then skipRequested = true end
end

function Dialogue.Play(tree: {[string]: Node}, startId: string)
    local current = startId

    while current do
        local node = tree[current]
        if not node then break end

        for _, c in choices:GetChildren() do
            if c:IsA("TextButton") then c:Destroy() end
        end

        frame.Visible = true
        typewrite(node.text, 45)

        if not node.options or #node.options == 0 then break end

        local chosen: string? = nil
        local waiting = true

        for i, opt in node.options do
            local btn = Instance.new("TextButton")
            btn.Name = "Option" .. i
            btn.Text = opt.label
            btn.Size = UDim2.new(1, 0, 0, 34)
            btn.LayoutOrder = i
            btn.Parent = choices
            btn.Activated:Connect(function()
                chosen = opt.goto
                waiting = false
            end)
        end

        while waiting do task.wait() end
        current = chosen
    end

    TweenService:Create(frame, TweenInfo.new(0.2), {BackgroundTransparency = 1}):Play()
    task.wait(0.2)
    frame.Visible = false
end

return Dialogue`,
  },

  {
    id: "notification-system",
    title: "Notification System",
    category: "ui",
    desc: "Stacked toast notifications with auto-dismiss, queueing and a hard cap so spam can't cover the screen.",
    author: "kiwi",
    rating: 4.7, views: 88240, copies: 24610, added: "2026-06-30",
    tags: ["toast", "hud"],
    code: `--!strict
-- Notify (LocalScript / ModuleScript on the client)

local TweenService = game:GetService("TweenService")
local Players = game:GetService("Players")

local gui = Instance.new("ScreenGui")
gui.Name = "Notifications"
gui.ResetOnSpawn = false
gui.ZIndexBehavior = Enum.ZIndexBehavior.Sibling
gui.Parent = Players.LocalPlayer:WaitForChild("PlayerGui")

local holder = Instance.new("Frame")
holder.AnchorPoint = Vector2.new(1, 1)
holder.Position = UDim2.new(1, -18, 1, -18)
holder.Size = UDim2.fromOffset(320, 400)
holder.BackgroundTransparency = 1
holder.Parent = gui

local layout = Instance.new("UIListLayout")
layout.VerticalAlignment = Enum.VerticalAlignment.Bottom
layout.HorizontalAlignment = Enum.HorizontalAlignment.Right
layout.Padding = UDim.new(0, 8)
layout.SortOrder = Enum.SortOrder.LayoutOrder
layout.Parent = holder

local MAX_ON_SCREEN = 4
local active = 0

local Notify = {}

function Notify.Push(text: string, duration: number?)
    if active >= MAX_ON_SCREEN then
        local oldest = holder:FindFirstChildWhichIsA("Frame")
        if oldest then oldest:Destroy() active -= 1 end
    end

    active += 1

    local card = Instance.new("Frame")
    card.Size = UDim2.new(1, 0, 0, 46)
    card.BackgroundColor3 = Color3.fromRGB(18, 20, 28)
    card.BackgroundTransparency = 1
    card.Parent = holder

    local corner = Instance.new("UICorner")
    corner.CornerRadius = UDim.new(0, 10)
    corner.Parent = card

    local label = Instance.new("TextLabel")
    label.Size = UDim2.fromScale(1, 1)
    label.BackgroundTransparency = 1
    label.Text = text
    label.TextColor3 = Color3.fromRGB(232, 238, 248)
    label.TextSize = 15
    label.Font = Enum.Font.GothamMedium
    label.TextTransparency = 1
    label.Parent = card

    local ti = TweenInfo.new(0.25, Enum.EasingStyle.Quad, Enum.EasingDirection.Out)
    TweenService:Create(card, ti, {BackgroundTransparency = 0.05}):Play()
    TweenService:Create(label, ti, {TextTransparency = 0}):Play()

    task.delay(duration or 3, function()
        if not card.Parent then return end
        TweenService:Create(card, ti, {BackgroundTransparency = 1}):Play()
        local out = TweenService:Create(label, ti, {TextTransparency = 1})
        out:Play()
        out.Completed:Wait()
        card:Destroy()
        active -= 1
    end)
end

return Notify`,
  },

  {
    id: "draggable-frame",
    title: "Draggable Frame",
    category: "ui",
    desc: "Drag any GUI frame with mouse or touch, clamped inside the viewport so windows can't be lost off-screen.",
    author: "sable",
    rating: 4.4, views: 44120, copies: 13875, added: "2026-03-22",
    tags: ["drag", "window"],
    code: `--!strict
-- Draggable: makes a frame movable via a handle, clamped to the screen.

local UIS = game:GetService("UserInputService")

local function makeDraggable(frame: GuiObject, handle: GuiObject?)
    local grip = handle or frame
    local dragging = false
    local dragStart: Vector3
    local startPos: UDim2

    local function update(input: InputObject)
        local delta = input.Position - dragStart
        local viewport = workspace.CurrentCamera.ViewportSize

        local newX = startPos.X.Offset + delta.X
        local newY = startPos.Y.Offset + delta.Y

        local maxX = viewport.X - frame.AbsoluteSize.X
        local maxY = viewport.Y - frame.AbsoluteSize.Y

        frame.Position = UDim2.new(
            startPos.X.Scale, math.clamp(newX, 0, math.max(0, maxX)),
            startPos.Y.Scale, math.clamp(newY, 0, math.max(0, maxY))
        )
    end

    grip.InputBegan:Connect(function(input)
        local t = input.UserInputType
        if t ~= Enum.UserInputType.MouseButton1 and t ~= Enum.UserInputType.Touch then return end

        dragging = true
        dragStart = input.Position
        startPos = frame.Position

        input.Changed:Connect(function()
            if input.UserInputState == Enum.UserInputState.End then
                dragging = false
            end
        end)
    end)

    UIS.InputChanged:Connect(function(input)
        if not dragging then return end
        local t = input.UserInputType
        if t == Enum.UserInputType.MouseMovement or t == Enum.UserInputType.Touch then
            update(input)
        end
    end)
end

return makeDraggable`,
  },

  {
    id: "npc-pathfinding",
    title: "NPC Pathfinding",
    category: "npc",
    desc: "PathfindingService wrapper with waypoint recomputation, jump handling, stuck detection and a hard retry budget.",
    author: "lucrit",
    rating: 4.9, views: 201477, copies: 52903, added: "2026-08-02", featured: true,
    tags: ["pathfinding", "ai", "navigation"],
    code: `--!strict
-- NPCPathfinder: robust wrapper around PathfindingService.

local PathfindingService = game:GetService("PathfindingService")

local Pathfinder = {}
Pathfinder.__index = Pathfinder

local STUCK_EPSILON = 0.6
local STUCK_SECONDS = 1.5
local MAX_RETRIES = 3

function Pathfinder.new(npc: Model)
    return setmetatable({
        npc = npc,
        humanoid = npc:WaitForChild("Humanoid") :: Humanoid,
        root = npc:WaitForChild("HumanoidRootPart") :: BasePart,
        path = PathfindingService:CreatePath({
            AgentRadius = 2,
            AgentHeight = 5,
            AgentCanJump = true,
            WaypointSpacing = 4,
        }),
        cancelled = false,
    }, Pathfinder)
end

function Pathfinder:Cancel()
    self.cancelled = true
    self.humanoid:MoveTo(self.root.Position)
end

function Pathfinder:_isStuck(lastPos: Vector3, elapsed: number): boolean
    return elapsed >= STUCK_SECONDS
        and (self.root.Position - lastPos).Magnitude < STUCK_EPSILON
end

function Pathfinder:GoTo(destination: Vector3): boolean
    self.cancelled = false

    for attempt = 1, MAX_RETRIES do
        if self.cancelled then return false end

        local ok = pcall(function()
            self.path:ComputeAsync(self.root.Position, destination)
        end)

        if not ok or self.path.Status ~= Enum.PathStatus.Success then
            task.wait(0.35 * attempt)
            continue
        end

        local waypoints = self.path:GetWaypoints()

        for i = 2, #waypoints do
            if self.cancelled then return false end
            local wp = waypoints[i]

            if wp.Action == Enum.PathWaypointAction.Jump then
                self.humanoid.Jump = true
            end

            self.humanoid:MoveTo(wp.Position)

            local lastPos = self.root.Position
            local started = os.clock()
            local reached = false

            while os.clock() - started < 6 do
                if self.cancelled then return false end
                if (self.root.Position - wp.Position).Magnitude < 3 then
                    reached = true
                    break
                end
                if self:_isStuck(lastPos, os.clock() - started) then break end
                task.wait(0.1)
            end

            if not reached then break end
            if i == #waypoints then return true end
        end
    end

    return false
end

return Pathfinder`,
  },

  {
    id: "enemy-ai-chase",
    title: "Enemy AI Chase",
    category: "npc",
    desc: "Aggro state machine — idle, investigate, chase, return. Picks the nearest valid target and gives up past leash range.",
    author: "voxelnine",
    rating: 4.6, views: 79640, copies: 18220, added: "2026-05-27",
    tags: ["ai", "state-machine", "aggro"],
    code: `--!strict
-- EnemyAI: small explicit state machine. No nested spawn soup.

local Players = game:GetService("Players")
local RunService = game:GetService("RunService")

local EnemyAI = {}
EnemyAI.__index = EnemyAI

type State = "Idle" | "Chase" | "Return"

local AGGRO_RANGE = 40
local LEASH_RANGE = 90
local ATTACK_RANGE = 6

function EnemyAI.new(npc: Model)
    local root = npc:WaitForChild("HumanoidRootPart") :: BasePart
    return setmetatable({
        npc = npc,
        humanoid = npc:WaitForChild("Humanoid") :: Humanoid,
        root = root,
        home = root.Position,
        state = "Idle" :: State,
        target = nil :: BasePart?,
    }, EnemyAI)
end

function EnemyAI:_nearestTarget(): BasePart?
    local best, bestDist = nil, AGGRO_RANGE

    for _, player in Players:GetPlayers() do
        local char = player.Character
        local hum = char and char:FindFirstChildOfClass("Humanoid")
        local orp = char and char:FindFirstChild("HumanoidRootPart") :: BasePart?
        if not (hum and orp) or hum.Health <= 0 then continue end

        local d = (orp.Position - self.root.Position).Magnitude
        if d < bestDist then best, bestDist = orp, d end
    end

    return best
end

function EnemyAI:Step()
    if self.humanoid.Health <= 0 then return end

    if self.state == "Idle" then
        local t = self:_nearestTarget()
        if t then
            self.target = t
            self.state = "Chase"
        end

    elseif self.state == "Chase" then
        local t = self.target
        if not t or not t.Parent then
            self.state = "Return"
            return
        end

        if (self.root.Position - self.home).Magnitude > LEASH_RANGE then
            self.target = nil
            self.state = "Return"
            return
        end

        local d = (t.Position - self.root.Position).Magnitude
        if d > ATTACK_RANGE then
            self.humanoid:MoveTo(t.Position)
        else
            self.humanoid:MoveTo(self.root.Position)
            self.npc:SetAttribute("Attacking", true)
        end

    elseif self.state == "Return" then
        self.humanoid:MoveTo(self.home)
        if (self.root.Position - self.home).Magnitude < 4 then
            self.state = "Idle"
        end
    end
end

function EnemyAI:Start()
    local acc = 0
    self.conn = RunService.Heartbeat:Connect(function(dt)
        acc += dt
        if acc < 0.2 then return end
        acc = 0
        self:Step()
    end)
end

function EnemyAI:Destroy()
    if self.conn then self.conn:Disconnect() end
end

return EnemyAI`,
  },

  {
    id: "wandering-npc",
    title: "Wandering NPC",
    category: "npc",
    desc: "Ambient villager movement — random points inside a radius, idle pauses, and a facing turn so they never look frozen.",
    author: "mono",
    rating: 4.3, views: 38900, copies: 9740, added: "2026-02-16",
    tags: ["ambient", "wander"],
    code: `--!strict
-- WanderingNPC: ambient idle movement around a home point.

local npc = script.Parent
local humanoid = npc:WaitForChild("Humanoid") :: Humanoid
local root = npc:WaitForChild("HumanoidRootPart") :: BasePart

local HOME = root.Position
local RADIUS = 25
local MIN_PAUSE, MAX_PAUSE = 1.5, 5

local rng = Random.new()

local function randomPoint(): Vector3
    local angle = rng:NextNumber(0, math.pi * 2)
    local dist = math.sqrt(rng:NextNumber()) * RADIUS
    return HOME + Vector3.new(math.cos(angle) * dist, 0, math.sin(angle) * dist)
end

while npc.Parent and humanoid.Health > 0 do
    local goal = randomPoint()

    humanoid:MoveTo(goal)
    local reached = humanoid.MoveToFinished:Wait()

    if not reached then
        humanoid.Jump = true
    end

    task.wait(rng:NextNumber(MIN_PAUSE, MAX_PAUSE))
end`,
  },

  {
    id: "admin-system",
    title: "Admin System",
    category: "admin",
    desc: "Chat command framework with permission ranks, argument parsing, alias support and an audit log of every command run.",
    author: "lucrit",
    rating: 4.8, views: 167332, copies: 44905, added: "2026-07-19", featured: true,
    tags: ["commands", "moderation", "ranks"],
    code: `--!strict
-- AdminSystem (ServerScriptService)

local Players = game:GetService("Players")

local RANKS = {
    [1234567] = 3,  -- owner  (replace with real UserIds)
    [7654321] = 2,  -- admin
}
local DEFAULT_RANK = 0

local Admin = {}
local commands: {[string]: {rank: number, run: (Player, {string}) -> ()}} = {}
local auditLog: {{user: string, cmd: string, at: number}} = {}

local function rankOf(player: Player): number
    return RANKS[player.UserId] or DEFAULT_RANK
end

local function findPlayer(query: string): Player?
    query = string.lower(query)
    for _, p in Players:GetPlayers() do
        if string.sub(string.lower(p.Name), 1, #query) == query then return p end
    end
    return nil
end

function Admin.Register(names: {string}, rank: number, run: (Player, {string}) -> ())
    for _, n in names do
        commands[string.lower(n)] = { rank = rank, run = run }
    end
end

-- ---- built-ins -------------------------------------------------

Admin.Register({"speed", "ws"}, 2, function(caller, args)
    local target = findPlayer(args[1] or "") or caller
    local value = tonumber(args[2]) or 16
    local hum = target.Character and target.Character:FindFirstChildOfClass("Humanoid")
    if hum then hum.WalkSpeed = math.clamp(value, 0, 200) end
end)

Admin.Register({"heal"}, 2, function(caller, args)
    local target = findPlayer(args[1] or "") or caller
    local hum = target.Character and target.Character:FindFirstChildOfClass("Humanoid")
    if hum then hum.Health = hum.MaxHealth end
end)

Admin.Register({"kick"}, 3, function(_, args)
    local target = findPlayer(args[1] or "")
    if target then
        target:Kick(table.concat(args, " ", 2))
    end
end)

-- ---- dispatch --------------------------------------------------

local function onChat(player: Player, message: string)
    if string.sub(message, 1, 1) ~= ":" then return end

    local parts = string.split(string.sub(message, 2), " ")
    local name = string.lower(table.remove(parts, 1) or "")
    local cmd = commands[name]
    if not cmd then return end

    if rankOf(player) < cmd.rank then return end

    table.insert(auditLog, { user = player.Name, cmd = message, at = os.time() })

    local ok, err = pcall(cmd.run, player, parts)
    if not ok then warn("[Admin] " .. name .. " failed: " .. tostring(err)) end
end

Players.PlayerAdded:Connect(function(player)
    player.Chatted:Connect(function(msg) onChat(player, msg) end)
end)

function Admin.GetAuditLog() return table.clone(auditLog) end

return Admin`,
  },

  {
    id: "ban-system",
    title: "Ban System",
    category: "admin",
    desc: "Persistent bans backed by DataStore, with expiry timestamps, reasons and an on-join check that runs before spawn.",
    author: "raxen",
    rating: 4.5, views: 62108, copies: 15330, added: "2026-04-08",
    tags: ["moderation", "datastore"],
    code: `--!strict
-- BanService (ServerScriptService)

local Players = game:GetService("Players")
local DataStoreService = game:GetService("DataStoreService")

local store = DataStoreService:GetDataStore("Bans_v1")

export type BanRecord = {
    reason: string,
    expiresAt: number?,  -- nil == permanent
    bannedBy: string,
    at: number,
}

local BanService = {}

local function key(userId: number): string
    return "u_" .. userId
end

function BanService.Get(userId: number): BanRecord?
    local ok, record = pcall(function()
        return store:GetAsync(key(userId))
    end)
    if not ok or not record then return nil end

    if record.expiresAt and os.time() >= record.expiresAt then
        pcall(function() store:RemoveAsync(key(userId)) end)
        return nil
    end

    return record
end

function BanService.Ban(userId: number, reason: string, seconds: number?, by: string)
    local record: BanRecord = {
        reason = reason,
        expiresAt = seconds and (os.time() + seconds) or nil,
        bannedBy = by,
        at = os.time(),
    }

    pcall(function() store:SetAsync(key(userId), record) end)

    local player = Players:GetPlayerByUserId(userId)
    if player then player:Kick("Banned: " .. reason) end
end

function BanService.Unban(userId: number)
    pcall(function() store:RemoveAsync(key(userId)) end)
end

local function formatKick(record: BanRecord): string
    if not record.expiresAt then
        return "You are permanently banned.\\nReason: " .. record.reason
    end
    local left = record.expiresAt - os.time()
    local hours = math.ceil(left / 3600)
    return "You are banned for " .. hours .. "h.\\nReason: " .. record.reason
end

Players.PlayerAdded:Connect(function(player)
    local record = BanService.Get(player.UserId)
    if record then player:Kick(formatKick(record)) end
end)

return BanService`,
  },

  {
    id: "datastore-system",
    title: "DataStore System",
    category: "data",
    desc: "Production save layer — session locking, retry with backoff, autosave loop, and BindToClose so nothing is lost on shutdown.",
    author: "lucrit",
    rating: 5.0, views: 233890, copies: 61470, added: "2026-08-05", featured: true,
    tags: ["datastore", "session-lock", "autosave"],
    code: `--!strict
-- DataService: session-locked player data with safe shutdown.

local Players = game:GetService("Players")
local DataStoreService = game:GetService("DataStoreService")
local RunService = game:GetService("RunService")

local store = DataStoreService:GetDataStore("PlayerData_v3")
local JOB = game.JobId ~= "" and game.JobId or "studio"

local TEMPLATE = {
    coins = 0,
    level = 1,
    xp = 0,
    inventory = {} :: {string},
}

local cache: {[Player]: typeof(TEMPLATE)} = {}
local loaded: {[Player]: boolean} = {}

local DataService = {}

local function retry<T>(fn: () -> T, attempts: number): (boolean, T?)
    for i = 1, attempts do
        local ok, result = pcall(fn)
        if ok then return true, result end
        task.wait(2 ^ i * 0.25)
    end
    return false, nil
end

local function reconcile(data: any): typeof(TEMPLATE)
    local out = table.clone(TEMPLATE)
    if typeof(data) == "table" then
        for k, v in data do
            if out[k] ~= nil then out[k] = v end
        end
    end
    return out
end

function DataService.Load(player: Player)
    local key = "p_" .. player.UserId

    local ok, raw = retry(function()
        return store:UpdateAsync(key, function(old)
            old = old or {}

            -- Session lock: refuse if another live server holds it.
            if old.__lock and old.__lock ~= JOB and os.time() - (old.__lockAt or 0) < 120 then
                return nil
            end

            old.__lock = JOB
            old.__lockAt = os.time()
            return old
        end)
    end, 4)

    if not ok or raw == nil then
        player:Kick("Your data is loading on another server. Rejoin in a minute.")
        return
    end

    cache[player] = reconcile(raw)
    loaded[player] = true
end

function DataService.Get(player: Player): typeof(TEMPLATE)?
    return cache[player]
end

function DataService.Save(player: Player, release: boolean)
    if not loaded[player] then return end
    local data = cache[player]
    if not data then return end

    local key = "p_" .. player.UserId

    retry(function()
        return store:UpdateAsync(key, function(old)
            local payload = table.clone(data)
            payload.__lock = release and nil or JOB
            payload.__lockAt = release and nil or os.time()
            return payload
        end)
    end, 3)
end

Players.PlayerAdded:Connect(DataService.Load)

Players.PlayerRemoving:Connect(function(player)
    DataService.Save(player, true)
    cache[player] = nil
    loaded[player] = nil
end)

-- autosave
task.spawn(function()
    while task.wait(90) do
        for _, player in Players:GetPlayers() do
            DataService.Save(player, false)
        end
    end
end)

game:BindToClose(function()
    if RunService:IsStudio() then return end
    for _, player in Players:GetPlayers() do
        task.spawn(DataService.Save, player, true)
    end
    task.wait(3)
end)

return DataService`,
  },

  {
    id: "leaderstats-saver",
    title: "Leaderstats Saver",
    category: "data",
    desc: "Minimal leaderstats that persist. Good starting point when a full data service is more than the game needs.",
    author: "kiwi",
    rating: 4.4, views: 121440, copies: 39018, added: "2026-01-30",
    tags: ["leaderstats", "beginner"],
    code: `--!strict
-- LeaderstatsSaver (ServerScriptService)

local Players = game:GetService("Players")
local DataStoreService = game:GetService("DataStoreService")

local store = DataStoreService:GetDataStore("Leaderstats_v1")

local function setup(player: Player)
    local stats = Instance.new("Folder")
    stats.Name = "leaderstats"

    local coins = Instance.new("IntValue")
    coins.Name = "Coins"
    coins.Parent = stats

    local ok, saved = pcall(function()
        return store:GetAsync("p_" .. player.UserId)
    end)

    coins.Value = (ok and typeof(saved) == "number") and saved or 0
    stats.Parent = player
end

local function save(player: Player)
    local coins = player:FindFirstChild("leaderstats")
        and player.leaderstats:FindFirstChild("Coins") :: IntValue?
    if not coins then return end

    pcall(function()
        store:SetAsync("p_" .. player.UserId, coins.Value)
    end)
end

Players.PlayerAdded:Connect(setup)
Players.PlayerRemoving:Connect(save)

game:BindToClose(function()
    for _, player in Players:GetPlayers() do
        task.spawn(save, player)
    end
    task.wait(2)
end)`,
  },

  {
    id: "session-locking",
    title: "Session Locking",
    category: "data",
    desc: "Standalone lock primitive — claim, heartbeat, release. Drop it in front of any DataStore to stop duplicate-server writes.",
    author: "sable",
    rating: 4.7, views: 54210, copies: 12088, added: "2026-06-05",
    tags: ["locking", "concurrency"],
    code: `--!strict
-- SessionLock: prevents two servers writing the same key.

local Lock = {}
Lock.__index = Lock

local LOCK_TTL = 120       -- seconds before a lock is considered stale
local HEARTBEAT = 30       -- how often we refresh our claim

function Lock.new(dataStore: DataStore, jobId: string)
    return setmetatable({
        store = dataStore,
        job = jobId ~= "" and jobId or "studio",
        held = {} :: {[string]: thread},
    }, Lock)
end

function Lock:Claim(key: string): (boolean, any)
    local ok, result = pcall(function()
        return self.store:UpdateAsync(key, function(old)
            old = old or {}
            local owner, at = old.__lock, old.__lockAt or 0

            if owner and owner ~= self.job and os.time() - at < LOCK_TTL then
                return nil  -- someone else holds it
            end

            old.__lock = self.job
            old.__lockAt = os.time()
            return old
        end)
    end)

    if not ok or result == nil then return false, nil end

    self.held[key] = task.spawn(function()
        while task.wait(HEARTBEAT) do
            pcall(function()
                self.store:UpdateAsync(key, function(old)
                    if not old or old.__lock ~= self.job then return nil end
                    old.__lockAt = os.time()
                    return old
                end)
            end)
        end
    end)

    return true, result
end

function Lock:Release(key: string)
    local thread = self.held[key]
    if thread then task.cancel(thread) end
    self.held[key] = nil

    pcall(function()
        self.store:UpdateAsync(key, function(old)
            if not old then return nil end
            if old.__lock ~= self.job then return nil end
            old.__lock = nil
            old.__lockAt = nil
            return old
        end)
    end)
end

return Lock`,
  },

  {
    id: "inventory-system",
    title: "Inventory System",
    category: "inventory",
    desc: "Stack-aware inventory with capacity limits, add/remove/split, and change signals the UI can bind to directly.",
    author: "lucrit",
    rating: 4.9, views: 198760, copies: 55120, added: "2026-07-31", featured: true,
    tags: ["inventory", "stacks", "signals"],
    code: `--!strict
-- Inventory: stack-aware container with change events.

local Inventory = {}
Inventory.__index = Inventory

export type Stack = { id: string, count: number }

function Inventory.new(slots: number, maxStack: number)
    local self = setmetatable({
        slots = slots,
        maxStack = maxStack,
        items = {} :: {Stack?},
        listeners = {} :: {(inv: any) -> ()},
    }, Inventory)

    for i = 1, slots do self.items[i] = nil end
    return self
end

function Inventory:OnChanged(fn: (any) -> ()): () -> ()
    table.insert(self.listeners, fn)
    return function()
        local i = table.find(self.listeners, fn)
        if i then table.remove(self.listeners, i) end
    end
end

function Inventory:_fire()
    for _, fn in self.listeners do
        task.spawn(fn, self)
    end
end

-- Returns the number that could NOT be added.
function Inventory:Add(id: string, count: number): number
    local remaining = count

    -- top up existing stacks first
    for i = 1, self.slots do
        if remaining <= 0 then break end
        local slot = self.items[i]
        if slot and slot.id == id and slot.count < self.maxStack then
            local room = self.maxStack - slot.count
            local moved = math.min(room, remaining)
            slot.count += moved
            remaining -= moved
        end
    end

    -- then fill empty slots
    for i = 1, self.slots do
        if remaining <= 0 then break end
        if self.items[i] == nil then
            local moved = math.min(self.maxStack, remaining)
            self.items[i] = { id = id, count = moved }
            remaining -= moved
        end
    end

    if remaining < count then self:_fire() end
    return remaining
end

function Inventory:Remove(id: string, count: number): boolean
    if self:Count(id) < count then return false end

    local remaining = count
    for i = self.slots, 1, -1 do
        if remaining <= 0 then break end
        local slot = self.items[i]
        if slot and slot.id == id then
            local taken = math.min(slot.count, remaining)
            slot.count -= taken
            remaining -= taken
            if slot.count <= 0 then self.items[i] = nil end
        end
    end

    self:_fire()
    return true
end

function Inventory:Count(id: string): number
    local total = 0
    for i = 1, self.slots do
        local slot = self.items[i]
        if slot and slot.id == id then total += slot.count end
    end
    return total
end

function Inventory:Serialize(): {Stack?}
    return table.clone(self.items)
end

return Inventory`,
  },

  {
    id: "hotbar",
    title: "Hotbar",
    category: "inventory",
    desc: "Nine-slot hotbar bound to number keys with selection highlight, scroll-wheel cycling and controller D-pad support.",
    author: "mono",
    rating: 4.5, views: 47730, copies: 12984, added: "2026-05-11",
    tags: ["hotbar", "input"],
    code: `--!strict
-- Hotbar (LocalScript): keyboard, scroll and gamepad selection.

local UIS = game:GetService("UserInputService")

local Hotbar = {}
Hotbar.__index = Hotbar

local SLOTS = 9

function Hotbar.new(onSelect: (index: number) -> ())
    local self = setmetatable({
        selected = 1,
        onSelect = onSelect,
        conns = {} :: {RBXScriptConnection},
    }, Hotbar)

    local keys = {
        [Enum.KeyCode.One] = 1, [Enum.KeyCode.Two] = 2, [Enum.KeyCode.Three] = 3,
        [Enum.KeyCode.Four] = 4, [Enum.KeyCode.Five] = 5, [Enum.KeyCode.Six] = 6,
        [Enum.KeyCode.Seven] = 7, [Enum.KeyCode.Eight] = 8, [Enum.KeyCode.Nine] = 9,
    }

    table.insert(self.conns, UIS.InputBegan:Connect(function(input, processed)
        if processed then return end

        local slot = keys[input.KeyCode]
        if slot then self:Select(slot) return end

        if input.KeyCode == Enum.KeyCode.DPadRight then self:Cycle(1) end
        if input.KeyCode == Enum.KeyCode.DPadLeft then self:Cycle(-1) end
    end))

    table.insert(self.conns, UIS.InputChanged:Connect(function(input, processed)
        if processed then return end
        if input.UserInputType ~= Enum.UserInputType.MouseWheel then return end
        self:Cycle(input.Position.Z > 0 and -1 or 1)
    end))

    return self
end

function Hotbar:Select(index: number)
    index = math.clamp(index, 1, SLOTS)
    if index == self.selected then return end
    self.selected = index
    self.onSelect(index)
end

function Hotbar:Cycle(delta: number)
    local next = self.selected + delta
    if next > SLOTS then next = 1 end
    if next < 1 then next = SLOTS end
    self:Select(next)
end

function Hotbar:Destroy()
    for _, c in self.conns do c:Disconnect() end
end

return Hotbar`,
  },

  {
    id: "shop-system",
    title: "Shop System",
    category: "shops",
    desc: "Server-validated purchases — the client never sends a price. Stock limits, per-player purchase caps and a receipt log.",
    author: "lucrit",
    rating: 4.8, views: 156220, copies: 40877, added: "2026-07-06", featured: true,
    tags: ["shop", "economy", "server-validated"],
    code: `--!strict
-- ShopService (ServerScriptService)
-- Clients send an item id. Nothing else is trusted.

local Players = game:GetService("Players")
local RS = game:GetService("ReplicatedStorage")

local BuyRemote = RS:WaitForChild("BuyItem") :: RemoteFunction

export type ShopItem = {
    price: number,
    stock: number?,     -- nil == unlimited
    perPlayer: number?,
}

local CATALOG: {[string]: ShopItem} = {
    ["sword_iron"]  = { price = 250 },
    ["potion_heal"] = { price = 40,  perPlayer = 10 },
    ["cape_rare"]   = { price = 5000, stock = 25 },
}

local purchases: {[Player]: {[string]: number}} = {}
local receipts: {{who: string, item: string, price: number, at: number}} = {}

local ShopService = {}

-- Swap these for your real currency layer.
local function getBalance(player: Player): number
    local stats = player:FindFirstChild("leaderstats")
    local coins = stats and stats:FindFirstChild("Coins") :: IntValue?
    return coins and coins.Value or 0
end

local function addBalance(player: Player, delta: number)
    local stats = player:FindFirstChild("leaderstats")
    local coins = stats and stats:FindFirstChild("Coins") :: IntValue?
    if coins then coins.Value += delta end
end

local function grant(player: Player, itemId: string)
    player:SetAttribute("Last_" .. itemId, os.time())
end

local function attempt(player: Player, itemId: string): (boolean, string)
    local item = CATALOG[itemId]
    if not item then return false, "No such item." end

    if item.stock ~= nil and item.stock <= 0 then
        return false, "Out of stock."
    end

    local mine = purchases[player] or {}
    if item.perPlayer and (mine[itemId] or 0) >= item.perPlayer then
        return false, "Purchase limit reached."
    end

    if getBalance(player) < item.price then
        return false, "Not enough coins."
    end

    addBalance(player, -item.price)
    if item.stock ~= nil then item.stock -= 1 end

    mine[itemId] = (mine[itemId] or 0) + 1
    purchases[player] = mine

    grant(player, itemId)
    table.insert(receipts, {
        who = player.Name, item = itemId, price = item.price, at = os.time(),
    })

    return true, "Purchased."
end

BuyRemote.OnServerInvoke = function(player, itemId)
    if typeof(itemId) ~= "string" then return false, "Bad request." end
    local ok, message = attempt(player, itemId)
    return ok, message
end

Players.PlayerRemoving:Connect(function(p) purchases[p] = nil end)

function ShopService.GetCatalog() return CATALOG end
function ShopService.GetReceipts() return table.clone(receipts) end

return ShopService`,
  },

  {
    id: "gamepass-shop",
    title: "Gamepass Shop",
    category: "shops",
    desc: "MarketplaceService flow done right — ownership cache, PromptGamePassPurchaseFinished handling and re-grant on rejoin.",
    author: "raxen",
    rating: 4.6, views: 68990, copies: 17203, added: "2026-06-21",
    tags: ["marketplace", "gamepass", "robux"],
    code: `--!strict
-- GamepassService (ServerScriptService)

local Players = game:GetService("Players")
local MarketplaceService = game:GetService("MarketplaceService")

local PASSES = {
    VIP        = 000000001,  -- replace with real ids
    DoubleCoin = 000000002,
}

local owned: {[Player]: {[number]: boolean}} = {}

local Gamepass = {}

local function check(player: Player, passId: number): boolean
    local cache = owned[player]
    if cache and cache[passId] ~= nil then return cache[passId] end

    local ok, result = pcall(function()
        return MarketplaceService:UserOwnsGamePassAsync(player.UserId, passId)
    end)

    local value = ok and result or false
    owned[player] = owned[player] or {}
    owned[player][passId] = value
    return value
end

local function applyPerks(player: Player)
    player:SetAttribute("VIP", check(player, PASSES.VIP))
    player:SetAttribute("CoinMultiplier", check(player, PASSES.DoubleCoin) and 2 or 1)
end

function Gamepass.Owns(player: Player, passId: number): boolean
    return check(player, passId)
end

function Gamepass.Prompt(player: Player, passId: number)
    if check(player, passId) then return end
    MarketplaceService:PromptGamePassPurchase(player, passId)
end

MarketplaceService.PromptGamePassPurchaseFinished:Connect(function(player, passId, wasPurchased)
    if not wasPurchased then return end
    owned[player] = owned[player] or {}
    owned[player][passId] = true
    applyPerks(player)
end)

Players.PlayerAdded:Connect(function(player)
    owned[player] = {}
    applyPerks(player)
end)

Players.PlayerRemoving:Connect(function(player)
    owned[player] = nil
end)

return Gamepass`,
  },

  {
    id: "tycoon-dropper",
    title: "Tycoon Dropper",
    category: "tycoon",
    desc: "Dropper that pools its parts instead of instancing endlessly — keeps a busy tycoon from tanking the server.",
    author: "kiwi",
    rating: 4.6, views: 91330, copies: 26440, added: "2026-05-18",
    tags: ["tycoon", "pooling", "performance"],
    code: `--!strict
-- Dropper with an object pool. Reuses parts instead of Instance.new spam.

local Dropper = {}
Dropper.__index = Dropper

local POOL_SIZE = 40

function Dropper.new(spout: BasePart, value: number, interval: number)
    local self = setmetatable({
        spout = spout,
        value = value,
        interval = interval,
        pool = {} :: {BasePart},
        running = false,
    }, Dropper)

    for _ = 1, POOL_SIZE do
        local p = Instance.new("Part")
        p.Size = Vector3.new(1, 1, 1)
        p.Material = Enum.Material.Neon
        p.Color = Color3.fromRGB(90, 190, 255)
        p.CanCollide = true
        p:SetAttribute("Value", value)
        p.Parent = nil
        table.insert(self.pool, p)
    end

    return self
end

function Dropper:_take(): BasePart?
    local p = table.remove(self.pool)
    return p
end

function Dropper:_give(part: BasePart)
    part.Parent = nil
    part.AssemblyLinearVelocity = Vector3.zero
    part.AssemblyAngularVelocity = Vector3.zero
    if #self.pool < POOL_SIZE then table.insert(self.pool, part) end
end

function Dropper:Start(container: Instance, lifetime: number)
    if self.running then return end
    self.running = true

    task.spawn(function()
        while self.running do
            local part = self:_take()
            if part then
                part.CFrame = self.spout.CFrame * CFrame.new(0, -1.5, 0)
                part.Parent = container

                task.delay(lifetime, function()
                    if part.Parent then self:_give(part) end
                end)
            end
            task.wait(self.interval)
        end
    end)
end

function Dropper:Stop()
    self.running = false
end

return Dropper`,
  },

  {
    id: "tycoon-button",
    title: "Tycoon Button",
    category: "tycoon",
    desc: "Purchase pad with owner check, price gating, dependency unlocks and a tween-in reveal of the bought model.",
    author: "sable",
    rating: 4.4, views: 58470, copies: 16220, added: "2026-04-27",
    tags: ["tycoon", "button", "unlock"],
    code: `--!strict
-- TycoonButton: touch pad that unlocks a model once paid for.

local TweenService = game:GetService("TweenService")
local Players = game:GetService("Players")

local pad = script.Parent :: BasePart
local tycoon = pad:FindFirstAncestor("Tycoon")

local PRICE = pad:GetAttribute("Price") :: number
local UNLOCKS = pad:GetAttribute("Unlocks") :: string
local REQUIRES = pad:GetAttribute("Requires") :: string?

local bought = false
local debounce: {[Player]: number} = {}

local function ownerOf(): Player?
    local id = tycoon and tycoon:GetAttribute("OwnerUserId") :: number?
    return id and Players:GetPlayerByUserId(id) or nil
end

local function coinsOf(player: Player): IntValue?
    local stats = player:FindFirstChild("leaderstats")
    return stats and stats:FindFirstChild("Coins") :: IntValue?
end

local function reveal(model: Model)
    for _, part in model:GetDescendants() do
        if not part:IsA("BasePart") then continue end
        local target = part.Transparency
        part.Transparency = 1
        TweenService:Create(part, TweenInfo.new(0.4), {Transparency = target}):Play()
    end
    model.Parent = tycoon
end

pad.Touched:Connect(function(hit)
    if bought then return end

    local char = hit:FindFirstAncestorOfClass("Model")
    local player = char and Players:GetPlayerFromCharacter(char)
    if not player or player ~= ownerOf() then return end

    if os.clock() - (debounce[player] or 0) < 0.5 then return end
    debounce[player] = os.clock()

    if REQUIRES and not tycoon:FindFirstChild(REQUIRES) then return end

    local coins = coinsOf(player)
    if not coins or coins.Value < PRICE then return end

    coins.Value -= PRICE
    bought = true

    local model = tycoon.Locked:FindFirstChild(UNLOCKS) :: Model?
    if model then reveal(model) end

    pad.Transparency = 1
    pad.CanTouch = false
end)`,
  },

  {
    id: "sprint-system",
    title: "Sprint System",
    category: "movement",
    desc: "Hold-to-sprint with a stamina bar, drain and regen curves, and an FOV punch that eases rather than snapping.",
    author: "lucrit",
    rating: 4.8, views: 133410, copies: 37905, added: "2026-07-22",
    tags: ["sprint", "stamina", "fov"],
    code: `--!strict
-- SprintSystem (LocalScript in StarterPlayerScripts)

local UIS = game:GetService("UserInputService")
local RunService = game:GetService("RunService")
local Players = game:GetService("Players")
local TweenService = game:GetService("TweenService")

local player = Players.LocalPlayer
local camera = workspace.CurrentCamera

local CONFIG = {
    WalkSpeed   = 16,
    SprintSpeed = 26,
    MaxStamina  = 100,
    DrainRate   = 22,   -- per second while sprinting
    RegenRate   = 16,   -- per second while not
    RegenDelay  = 1.0,
    BaseFov     = 70,
    SprintFov   = 80,
}

local stamina = CONFIG.MaxStamina
local sprinting = false
local lastDrain = 0

local function humanoid(): Humanoid?
    local char = player.Character
    return char and char:FindFirstChildOfClass("Humanoid")
end

local function setFov(target: number)
    TweenService:Create(camera, TweenInfo.new(0.35, Enum.EasingStyle.Quad), {
        FieldOfView = target,
    }):Play()
end

local function setSprinting(on: boolean)
    if on == sprinting then return end
    sprinting = on

    local hum = humanoid()
    if hum then
        hum.WalkSpeed = on and CONFIG.SprintSpeed or CONFIG.WalkSpeed
    end
    setFov(on and CONFIG.SprintFov or CONFIG.BaseFov)
end

UIS.InputBegan:Connect(function(input, processed)
    if processed then return end
    if input.KeyCode == Enum.KeyCode.LeftShift and stamina > 5 then
        setSprinting(true)
    end
end)

UIS.InputEnded:Connect(function(input)
    if input.KeyCode == Enum.KeyCode.LeftShift then
        setSprinting(false)
    end
end)

RunService.Heartbeat:Connect(function(dt)
    local hum = humanoid()
    if not hum then return end

    local moving = hum.MoveDirection.Magnitude > 0.1

    if sprinting and moving then
        stamina -= CONFIG.DrainRate * dt
        lastDrain = os.clock()
        if stamina <= 0 then
            stamina = 0
            setSprinting(false)
        end
    elseif os.clock() - lastDrain >= CONFIG.RegenDelay then
        stamina = math.min(CONFIG.MaxStamina, stamina + CONFIG.RegenRate * dt)
    end

    player:SetAttribute("Stamina", math.floor(stamina))
end)`,
  },

  {
    id: "double-jump",
    title: "Double Jump",
    category: "movement",
    desc: "Air jump with a reset on landing, configurable extra jumps and an impulse that feels right rather than floaty.",
    author: "voxelnine",
    rating: 4.5, views: 84520, copies: 25710, added: "2026-03-09",
    tags: ["jump", "air"],
    code: `--!strict
-- DoubleJump (LocalScript in StarterCharacterScripts)

local UIS = game:GetService("UserInputService")

local character = script.Parent
local humanoid = character:WaitForChild("Humanoid") :: Humanoid
local root = character:WaitForChild("HumanoidRootPart") :: BasePart

local EXTRA_JUMPS = 1
local IMPULSE = 52

local jumpsLeft = EXTRA_JUMPS
local canAirJump = false

humanoid.StateChanged:Connect(function(_, new)
    if new == Enum.HumanoidStateType.Landed
        or new == Enum.HumanoidStateType.Running
        or new == Enum.HumanoidStateType.Seated then
        jumpsLeft = EXTRA_JUMPS
        canAirJump = false
    elseif new == Enum.HumanoidStateType.Freefall then
        -- brief delay stops the initial jump consuming an air jump
        task.delay(0.15, function() canAirJump = true end)
    end
end)

local function airJump()
    if jumpsLeft <= 0 or not canAirJump then return end
    jumpsLeft -= 1

    local v = root.AssemblyLinearVelocity
    root.AssemblyLinearVelocity = Vector3.new(v.X, IMPULSE, v.Z)

    local puff = Instance.new("Attachment")
    puff.Name = "AirJumpFX"
    puff.Parent = root
    task.delay(0.4, function() puff:Destroy() end)
end

UIS.JumpRequest:Connect(function()
    if humanoid:GetState() == Enum.HumanoidStateType.Freefall then
        airJump()
    end
end)`,
  },

  {
    id: "wall-run",
    title: "Wall Run",
    category: "movement",
    desc: "Raycast wall detection with camera tilt, gravity dampening and a timed dismount so players can't hang forever.",
    author: "mono",
    rating: 4.7, views: 102880, copies: 28115, added: "2026-06-12",
    tags: ["parkour", "raycast", "camera-tilt"],
    code: `--!strict
-- WallRun (LocalScript in StarterCharacterScripts)

local RunService = game:GetService("RunService")
local UIS = game:GetService("UserInputService")

local character = script.Parent
local humanoid = character:WaitForChild("Humanoid") :: Humanoid
local root = character:WaitForChild("HumanoidRootPart") :: BasePart
local camera = workspace.CurrentCamera

local MAX_DURATION = 2.2
local CHECK_DISTANCE = 3.2
local RUN_SPEED = 30
local TILT = math.rad(12)

local params = RaycastParams.new()
params.FilterType = Enum.RaycastFilterType.Exclude
params.FilterDescendantsInstances = {character}

local force: LinearVelocity? = nil
local attachment: Attachment? = nil
local running = false
local startedAt = 0
local side = 0

local function detach()
    running = false
    side = 0
    if force then force:Destroy() force = nil end
    if attachment then attachment:Destroy() attachment = nil end
end

local function attach(dir: Vector3)
    attachment = Instance.new("Attachment")
    attachment.Parent = root

    force = Instance.new("LinearVelocity")
    force.Attachment0 = attachment
    force.MaxForce = math.huge
    force.RelativeTo = Enum.ActuatorRelativeTo.World
    force.VectorVelocity = dir * RUN_SPEED + Vector3.new(0, 1.5, 0)
    force.Parent = root

    running = true
    startedAt = os.clock()
end

RunService.RenderStepped:Connect(function()
    if humanoid:GetState() ~= Enum.HumanoidStateType.Freefall then
        if running then detach() end
        return
    end

    if running and os.clock() - startedAt > MAX_DURATION then
        detach()
        return
    end

    if running then
        camera.CFrame = camera.CFrame * CFrame.Angles(0, 0, TILT * side)
        return
    end

    if humanoid.MoveDirection.Magnitude < 0.1 then return end

    for _, s in {1, -1} do
        local origin = root.Position
        local dir = root.CFrame.RightVector * s * CHECK_DISTANCE
        local hit = workspace:Raycast(origin, dir, params)

        if hit then
            local along = hit.Normal:Cross(Vector3.yAxis) * -s
            if along.Magnitude < 0.01 then continue end
            side = s
            attach(along.Unit)
            break
        end
    end
end)

UIS.JumpRequest:Connect(function()
    if running then
        local v = root.AssemblyLinearVelocity
        root.AssemblyLinearVelocity = Vector3.new(v.X, 48, v.Z)
        detach()
    end
end)`,
  },

  {
    id: "animation-controller",
    title: "Animation Controller",
    category: "animation",
    desc: "Preloads tracks, cross-fades between states and stops competing animations so poses never fight each other.",
    author: "lucrit",
    rating: 4.7, views: 111250, copies: 30422, added: "2026-07-02",
    tags: ["animation", "blending"],
    code: `--!strict
-- AnimController: named tracks with clean cross-fading.

local AnimController = {}
AnimController.__index = AnimController

function AnimController.new(humanoid: Humanoid)
    local animator = humanoid:FindFirstChildOfClass("Animator")
        or Instance.new("Animator", humanoid)

    return setmetatable({
        animator = animator,
        tracks = {} :: {[string]: AnimationTrack},
        current = nil :: string?,
    }, AnimController)
end

function AnimController:Load(name: string, animationId: string, priority: Enum.AnimationPriority?)
    local anim = Instance.new("Animation")
    anim.AnimationId = animationId

    local track = self.animator:LoadAnimation(anim)
    track.Priority = priority or Enum.AnimationPriority.Action
    self.tracks[name] = track

    return track
end

function AnimController:Play(name: string, fade: number?, speed: number?)
    local track = self.tracks[name]
    if not track then
        warn("[AnimController] no track named " .. name)
        return
    end

    if self.current == name and track.IsPlaying then return end

    local blend = fade or 0.18

    if self.current then
        local old = self.tracks[self.current]
        if old and old.IsPlaying then old:Stop(blend) end
    end

    track:Play(blend)
    if speed then track:AdjustSpeed(speed) end
    self.current = name

    return track
end

function AnimController:StopAll(fade: number?)
    for _, track in self.tracks do
        if track.IsPlaying then track:Stop(fade or 0.15) end
    end
    self.current = nil
end

function AnimController:Destroy()
    self:StopAll(0)
    table.clear(self.tracks)
end

return AnimController`,
  },

  {
    id: "emote-system",
    title: "Emote System",
    category: "animation",
    desc: "Radial emote wheel that replicates to other players, cancels on movement, and won't fire while the character is airborne.",
    author: "kiwi",
    rating: 4.4, views: 64330, copies: 18902, added: "2026-04-14",
    tags: ["emote", "replication"],
    code: `--!strict
-- EmoteSystem — client requests, server replicates to everyone.

-- === CLIENT (LocalScript) =======================================
local RS = game:GetService("ReplicatedStorage")
local Players = game:GetService("Players")

local PlayEmote = RS:WaitForChild("PlayEmote") :: RemoteEvent
local player = Players.LocalPlayer

local EMOTES = {
    wave  = "rbxassetid://507770239",
    dance = "rbxassetid://507771019",
    point = "rbxassetid://507770453",
    sit   = "rbxassetid://507768133",
}

local playing: AnimationTrack? = nil

local function stop()
    if playing then playing:Stop(0.2) playing = nil end
end

local function request(name: string)
    local char = player.Character
    local hum = char and char:FindFirstChildOfClass("Humanoid")
    if not hum then return end
    if hum.FloorMaterial == Enum.Material.Air then return end
    if hum.MoveDirection.Magnitude > 0.1 then return end

    PlayEmote:FireServer(name)
end

PlayEmote.OnClientEvent:Connect(function(who: Player, name: string)
    local char = who.Character
    local hum = char and char:FindFirstChildOfClass("Humanoid")
    local animator = hum and hum:FindFirstChildOfClass("Animator")
    if not animator or not EMOTES[name] then return end

    if who == player then stop() end

    local anim = Instance.new("Animation")
    anim.AnimationId = EMOTES[name]
    local track = animator:LoadAnimation(anim)
    track.Priority = Enum.AnimationPriority.Action4
    track:Play(0.2)

    if who == player then
        playing = track
        local conn
        conn = hum:GetPropertyChangedSignal("MoveDirection"):Connect(function()
            if hum.MoveDirection.Magnitude > 0.1 then
                stop()
                conn:Disconnect()
            end
        end)
    end
end)

return { Request = request, Stop = stop }`,
  },

  {
    id: "signal-class",
    title: "Signal Class",
    category: "utilities",
    desc: "Lightweight BindableEvent replacement — no instance overhead, supports Once, Wait and returns a disconnect handle.",
    author: "sable",
    rating: 4.9, views: 145770, copies: 42011, added: "2026-06-25",
    tags: ["signal", "events", "core"],
    code: `--!strict
-- Signal: a tiny, allocation-light event implementation.

local Signal = {}
Signal.__index = Signal

export type Connection = { Disconnect: (Connection) -> () }

local Connection = {}
Connection.__index = Connection

function Connection:Disconnect()
    if not self.connected then return end
    self.connected = false

    local handlers = self.signal.handlers
    local index = table.find(handlers, self)
    if index then table.remove(handlers, index) end
end

function Signal.new()
    return setmetatable({ handlers = {} }, Signal)
end

function Signal:Connect(fn: (...any) -> ())
    local conn = setmetatable({
        signal = self,
        fn = fn,
        connected = true,
    }, Connection)

    table.insert(self.handlers, conn)
    return conn
end

function Signal:Once(fn: (...any) -> ())
    local conn
    conn = self:Connect(function(...)
        conn:Disconnect()
        fn(...)
    end)
    return conn
end

function Signal:Fire(...)
    -- iterate a copy so handlers can disconnect mid-fire
    local snapshot = table.clone(self.handlers)
    for _, conn in snapshot do
        if conn.connected then
            task.spawn(conn.fn, ...)
        end
    end
end

function Signal:Wait()
    local thread = coroutine.running()
    local conn
    conn = self:Connect(function(...)
        conn:Disconnect()
        task.spawn(thread, ...)
    end)
    return coroutine.yield()
end

function Signal:DisconnectAll()
    for _, conn in table.clone(self.handlers) do
        conn:Disconnect()
    end
end

return Signal`,
  },

  {
    id: "trove-cleanup",
    title: "Trove / Cleanup",
    category: "utilities",
    desc: "Tracks instances, connections and threads, then tears all of them down in one call. Kills a whole class of memory leaks.",
    author: "lucrit",
    rating: 4.9, views: 128900, copies: 36740, added: "2026-05-30",
    tags: ["cleanup", "maid", "memory"],
    code: `--!strict
-- Trove: one Destroy() to clean up everything you gave it.

local Trove = {}
Trove.__index = Trove

type Trackable = Instance | RBXScriptConnection | thread | () -> () | {Destroy: (any) -> ()}

function Trove.new()
    return setmetatable({ items = {} :: {Trackable} }, Trove)
end

function Trove:Add<T>(item: T & Trackable): T
    table.insert(self.items, item)
    return item
end

function Trove:Connect(signal: RBXScriptSignal, fn: (...any) -> ()): RBXScriptConnection
    return self:Add(signal:Connect(fn))
end

function Trove:Remove(item: Trackable)
    local index = table.find(self.items, item)
    if not index then return end
    table.remove(self.items, index)
    Trove._clean(item)
end

function Trove._clean(item: Trackable)
    local t = typeof(item)

    if t == "Instance" then
        (item :: Instance):Destroy()
    elseif t == "RBXScriptConnection" then
        (item :: RBXScriptConnection):Disconnect()
    elseif t == "thread" then
        task.cancel(item :: thread)
    elseif t == "function" then
        (item :: () -> ())()
    elseif t == "table" and (item :: any).Destroy then
        (item :: any):Destroy()
    end
end

function Trove:Clean()
    -- reverse order: last added is cleaned first
    for i = #self.items, 1, -1 do
        Trove._clean(self.items[i])
        self.items[i] = nil
    end
end

Trove.Destroy = Trove.Clean

return Trove`,
  },

  {
    id: "remote-throttle",
    title: "Remote Throttle",
    category: "utilities",
    desc: "Per-player rate limiter for RemoteEvents. Drops floods before your handler runs and flags repeat offenders.",
    author: "raxen",
    rating: 4.6, views: 71440, copies: 19806, added: "2026-03-31",
    tags: ["remote", "rate-limit", "security"],
    code: `--!strict
-- RemoteThrottle: token-bucket rate limiting for remotes.

local Players = game:GetService("Players")

local Throttle = {}
Throttle.__index = Throttle

-- every live limiter, so we can drop per-player state on leave
local instances: {any} = {}
setmetatable(instances, { __mode = "v" })

function Throttle.new(ratePerSecond: number, burst: number)
    local self = setmetatable({
        rate = ratePerSecond,
        burst = burst,
        buckets = {} :: {[Player]: {tokens: number, last: number}},
        strikes = {} :: {[Player]: number},
    }, Throttle)

    table.insert(instances, self)
    return self
end

function Throttle:Allow(player: Player): boolean
    local now = os.clock()
    local b = self.buckets[player]

    if not b then
        b = { tokens = self.burst, last = now }
        self.buckets[player] = b
    end

    b.tokens = math.min(self.burst, b.tokens + (now - b.last) * self.rate)
    b.last = now

    if b.tokens < 1 then
        self.strikes[player] = (self.strikes[player] or 0) + 1
        return false
    end

    b.tokens -= 1
    return true
end

function Throttle:Strikes(player: Player): number
    return self.strikes[player] or 0
end

function Throttle:Wrap(remote: RemoteEvent, handler: (Player, ...any) -> ())
    remote.OnServerEvent:Connect(function(player, ...)
        if not self:Allow(player) then return end
        handler(player, ...)
    end)
end

function Throttle:Forget(player: Player)
    self.buckets[player] = nil
    self.strikes[player] = nil
end

Players.PlayerRemoving:Connect(function(player)
    for _, limiter in instances do
        limiter:Forget(player)
    end
end)

return Throttle`,
  },

  {
    id: "leaderboard-system",
    title: "Leaderboard System",
    category: "other",
    desc: "Global OrderedDataStore leaderboard with paged fetch, a refresh interval and rendered SurfaceGui rows.",
    author: "lucrit",
    rating: 4.8, views: 174510, copies: 46320, added: "2026-07-25", featured: true,
    tags: ["leaderboard", "ordereddatastore", "global"],
    code: `--!strict
-- GlobalLeaderboard (ServerScriptService)

local DataStoreService = game:GetService("DataStoreService")
local Players = game:GetService("Players")

local ordered = DataStoreService:GetOrderedDataStore("Coins_Global_v1")

local REFRESH_SECONDS = 60
local TOP_COUNT = 25

local board = script.Parent:WaitForChild("SurfaceGui")
local rows = board:WaitForChild("Rows") :: Frame
local template = rows:WaitForChild("RowTemplate") :: Frame

template.Visible = false

local function nameFor(userId: number): string
    local ok, name = pcall(function()
        return Players:GetNameFromUserIdAsync(userId)
    end)
    return ok and name or ("User_" .. userId)
end

local function render(entries: {{key: string, value: number}})
    for _, child in rows:GetChildren() do
        if child:IsA("Frame") and child ~= template then child:Destroy() end
    end

    for rank, entry in entries do
        local row = template:Clone()
        row.Name = "Row" .. rank
        row.LayoutOrder = rank
        row.Visible = true

        ;(row:WaitForChild("Rank") :: TextLabel).Text = "#" .. rank
        ;(row:WaitForChild("Player") :: TextLabel).Text = nameFor(tonumber(entry.key) or 0)
        ;(row:WaitForChild("Value") :: TextLabel).Text = string.format("%d", entry.value)

        row.Parent = rows
    end
end

local function refresh()
    local ok, pages = pcall(function()
        return ordered:GetSortedAsync(false, TOP_COUNT)
    end)
    if not ok then return end

    local page = pages:GetCurrentPage()
    render(page)
end

-- push each player's score on leave
Players.PlayerRemoving:Connect(function(player)
    local stats = player:FindFirstChild("leaderstats")
    local coins = stats and stats:FindFirstChild("Coins") :: IntValue?
    if not coins then return end

    pcall(function()
        ordered:SetAsync(tostring(player.UserId), coins.Value)
    end)
end)

task.spawn(function()
    while true do
        refresh()
        task.wait(REFRESH_SECONDS)
    end
end)`,
  },

  {
    id: "day-night-cycle",
    title: "Day / Night Cycle",
    category: "other",
    desc: "Smooth clock advance with lighting presets that interpolate — ambient, brightness, fog and outdoor tint per phase.",
    author: "voxelnine",
    rating: 4.6, views: 89210, copies: 24177, added: "2026-05-06",
    tags: ["lighting", "atmosphere", "cycle"],
    code: `--!strict
-- DayNightCycle (ServerScriptService)

local Lighting = game:GetService("Lighting")
local RunService = game:GetService("RunService")

local MINUTES_PER_DAY = 12   -- real minutes for one full in-game day

type Preset = {
    at: number,               -- clock hour
    ambient: Color3,
    brightness: number,
    fog: number,
    tint: Color3,
}

local PRESETS: {Preset} = {
    { at = 0,  ambient = Color3.fromRGB(18, 22, 40),  brightness = 0.6, fog = 260, tint = Color3.fromRGB(120, 140, 200) },
    { at = 6,  ambient = Color3.fromRGB(90, 80, 90),   brightness = 1.6, fog = 420, tint = Color3.fromRGB(240, 200, 180) },
    { at = 12, ambient = Color3.fromRGB(130, 135, 145),brightness = 2.4, fog = 900, tint = Color3.fromRGB(255, 255, 255) },
    { at = 18, ambient = Color3.fromRGB(110, 80, 70),  brightness = 1.4, fog = 380, tint = Color3.fromRGB(255, 190, 150) },
    { at = 24, ambient = Color3.fromRGB(18, 22, 40),   brightness = 0.6, fog = 260, tint = Color3.fromRGB(120, 140, 200) },
}

local function bracket(hour: number): (Preset, Preset, number)
    for i = 1, #PRESETS - 1 do
        local a, b = PRESETS[i], PRESETS[i + 1]
        if hour >= a.at and hour <= b.at then
            local span = b.at - a.at
            local t = span > 0 and (hour - a.at) / span or 0
            return a, b, t
        end
    end
    return PRESETS[1], PRESETS[2], 0
end

local clock = 8  -- start mid-morning

RunService.Heartbeat:Connect(function(dt)
    clock += (dt / (MINUTES_PER_DAY * 60)) * 24
    if clock >= 24 then clock -= 24 end

    Lighting.ClockTime = clock

    local a, b, t = bracket(clock)
    Lighting.Ambient = a.ambient:Lerp(b.ambient, t)
    Lighting.Brightness = a.brightness + (b.brightness - a.brightness) * t
    Lighting.FogEnd = a.fog + (b.fog - a.fog) * t
    Lighting.OutdoorAmbient = a.tint:Lerp(b.tint, t)
end)`,
  },

  {
    id: "music-zone-player",
    title: "Music Zone Player",
    category: "other",
    desc: "Region-based soundtrack that cross-fades when a player enters a zone. No abrupt cuts, no stacked tracks.",
    author: "mono",
    rating: 4.5, views: 52990, copies: 14508, added: "2026-02-24",
    tags: ["audio", "zones", "crossfade"],
    code: `--!strict
-- MusicZones (LocalScript in StarterPlayerScripts)

local RunService = game:GetService("RunService")
local TweenService = game:GetService("TweenService")
local Players = game:GetService("Players")
local SoundService = game:GetService("SoundService")

local player = Players.LocalPlayer

local ZONES = workspace:WaitForChild("MusicZones")
local FADE = 1.4
local TARGET_VOLUME = 0.35

local sounds: {[string]: Sound} = {}
local currentZone: string? = nil

local function soundFor(zone: BasePart): Sound
    local id = zone:GetAttribute("SoundId") :: string
    if sounds[id] then return sounds[id] end

    local s = Instance.new("Sound")
    s.SoundId = id
    s.Looped = true
    s.Volume = 0
    s.Parent = SoundService
    s:Play()

    sounds[id] = s
    return s
end

local function fade(sound: Sound, to: number)
    TweenService:Create(sound, TweenInfo.new(FADE), {Volume = to}):Play()
end

local function zoneAt(position: Vector3): BasePart?
    for _, zone in ZONES:GetChildren() do
        if not zone:IsA("BasePart") then continue end
        local local_ = zone.CFrame:PointToObjectSpace(position)
        local half = zone.Size / 2
        if math.abs(local_.X) <= half.X
            and math.abs(local_.Y) <= half.Y
            and math.abs(local_.Z) <= half.Z then
            return zone
        end
    end
    return nil
end

local accumulator = 0

RunService.Heartbeat:Connect(function(dt)
    accumulator += dt
    if accumulator < 0.4 then return end
    accumulator = 0

    local char = player.Character
    local root = char and char:FindFirstChild("HumanoidRootPart") :: BasePart?
    if not root then return end

    local zone = zoneAt(root.Position)
    local name = zone and zone.Name or nil
    if name == currentZone then return end

    if currentZone then
        local old = ZONES:FindFirstChild(currentZone) :: BasePart?
        if old then fade(soundFor(old), 0) end
    end

    if zone then fade(soundFor(zone), TARGET_VOLUME) end
    currentZone = name
end)`,
  },

  {
    id: "anti-exploit-basics",
    title: "Anti-Exploit Basics",
    category: "other",
    desc: "Server-side sanity checks — speed, teleport distance and fly detection with a tolerance window that avoids false positives.",
    author: "raxen",
    rating: 4.7, views: 158030, copies: 43119, added: "2026-06-18",
    tags: ["security", "anti-cheat", "server"],
    code: `--!strict
-- AntiExploit (ServerScriptService)
-- Heuristics only. Nothing here replaces server authority.

local Players = game:GetService("Players")
local RunService = game:GetService("RunService")

local CONFIG = {
    MaxSpeed        = 34,     -- studs/sec, generous headroom above sprint
    MaxTeleport     = 90,     -- studs in one tick
    AirGraceSeconds = 3.5,
    Strikes         = 4,
}

type Track = {
    lastPos: Vector3,
    lastCheck: number,
    airborneSince: number?,
    strikes: number,
}

local tracked: {[Player]: Track} = {}

local function flag(player: Player, reason: string)
    local t = tracked[player]
    if not t then return end

    t.strikes += 1
    warn(string.format("[AntiExploit] %s -> %s (%d)", player.Name, reason, t.strikes))

    if t.strikes >= CONFIG.Strikes then
        player:Kick("Kicked by anti-cheat.")
    end
end

local function reset(player: Player)
    local root = player.Character and player.Character:FindFirstChild("HumanoidRootPart") :: BasePart?
    tracked[player] = {
        lastPos = root and root.Position or Vector3.zero,
        lastCheck = os.clock(),
        airborneSince = nil,
        strikes = tracked[player] and tracked[player].strikes or 0,
    }
end

Players.PlayerAdded:Connect(function(player)
    player.CharacterAdded:Connect(function() task.wait(1) reset(player) end)
end)

Players.PlayerRemoving:Connect(function(player) tracked[player] = nil end)

RunService.Heartbeat:Connect(function()
    for player, t in tracked do
        local char = player.Character
        local hum = char and char:FindFirstChildOfClass("Humanoid")
        local root = char and char:FindFirstChild("HumanoidRootPart") :: BasePart?
        if not (hum and root) or hum.Health <= 0 then continue end

        local now = os.clock()
        local dt = now - t.lastCheck
        if dt < 0.5 then continue end

        local delta = root.Position - t.lastPos
        local distance = delta.Magnitude

        if distance > CONFIG.MaxTeleport then
            flag(player, "teleport")
            root.CFrame = CFrame.new(t.lastPos)
        elseif distance / dt > CONFIG.MaxSpeed then
            flag(player, "speed")
        end

        if hum.FloorMaterial == Enum.Material.Air then
            t.airborneSince = t.airborneSince or now
            if now - t.airborneSince > CONFIG.AirGraceSeconds
                and math.abs(root.AssemblyLinearVelocity.Y) < 1 then
                flag(player, "fly")
            end
        else
            t.airborneSince = nil
        end

        t.lastPos = root.Position
        t.lastCheck = now
    end
end)`,
  },
];

/* ------------------------------------------------------------------ */

export const CONTRIBUTORS = [
  { user: "lucrit",    scripts: 12, views: 1834920, rep: 9840, hue: 210 },
  { user: "voxelnine", scripts: 5,  views: 458200,  rep: 4120, hue: 285 },
  { user: "mono",      scripts: 5,  views: 351410,  rep: 3380, hue: 150 },
  { user: "raxen",     scripts: 5,  views: 411670,  rep: 3910, hue: 30  },
  { user: "kiwi",      scripts: 4,  views: 326340,  rep: 2970, hue: 100 },
  { user: "sable",     scripts: 4,  views: 372410,  rep: 3240, hue: 320 },
];

export function categoryOf(id) {
  return CATEGORIES.find((c) => c.id === id) || CATEGORIES[CATEGORIES.length - 1];
}
