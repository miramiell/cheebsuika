(() => {
  "use strict";

  const {
    Engine,
    Runner,
    Bodies,
    Body,
    Composite,
    Events
  } = Matter;

  const canvas = document.getElementById("game-canvas");
  const container = document.getElementById("game-container");
  const scoreEl = document.getElementById("score");
  const nextBallEl = document.getElementById("next-ball");
  const gameOverEl = document.getElementById("game-over");
  const finalScoreEl = document.getElementById("final-score");
  const restartButton = document.getElementById("restart-button");
  const restartTop = document.getElementById("restart-top");

  const ctx = canvas.getContext("2d");

  // Larger pieces so the characters are easier to see on phones.
  const LEVELS = [
    { radius: 40, points: 1 },
    { radius: 52, points: 3 },
    { radius: 65, points: 6 },
    { radius: 82, points: 10 },
    { radius: 100, points: 15 },
    { radius: 120, points: 21 },
    { radius: 150, points: 28 },
    { radius: 175, points: 36 }
  ];

  const SPAWN_LEVELS = [0, 0, 0, 1, 1, 2];

  let engine;
  let runner;
  let width = 0;
  let height = 0;
  let scale = 1;
  let groundY = 0;
  let dangerY = 0;
  let currentLevel = 0;
  let nextLevel = 0;
  let score = 0;
  let aimX = 0;
  let canDrop = true;
  let gameOver = false;
  let mergeLock = false;
  let dangerStarted = null;
  let resizeObserver = null;

  function randomNextLevel() {
    return SPAWN_LEVELS[Math.floor(Math.random() * SPAWN_LEVELS.length)];
  }

  function resizeCanvas() {
    const rect = container.getBoundingClientRect();
    width = rect.width;
    height = rect.height;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    scale = width / 430;
    groundY = height - 5;
    dangerY = height * 0.19;

    if (!aimX) aimX = width / 2;
    aimX = clampAim(aimX);

    if (engine) {
      rebuildWalls();
    }
  }

  function clampAim(x) {
    const radius = LEVELS[currentLevel].radius * scale;
    return Math.max(radius + 3, Math.min(width - radius - 3, x));
  }

  function rebuildWalls() {
    const oldWalls = Composite.allBodies(engine.world)
      .filter(body => body.isStatic && body.gameWall);

    Composite.remove(engine.world, oldWalls);

    const wallThickness = 40;
    const wallLeft = Bodies.rectangle(
      -wallThickness / 2,
      height / 2,
      wallThickness,
      height * 2,
      { isStatic: true }
    );
    const wallRight = Bodies.rectangle(
      width + wallThickness / 2,
      height / 2,
      wallThickness,
      height * 2,
      { isStatic: true }
    );
    const floor = Bodies.rectangle(
      width / 2,
      groundY + wallThickness / 2,
      width,
      wallThickness,
      { isStatic: true }
    );

    [wallLeft, wallRight, floor].forEach(body => {
      body.gameWall = true;
      body.restitution = 0.05;
      body.friction = 0.65;
    });

    Composite.add(engine.world, [wallLeft, wallRight, floor]);
  }

  function setupEngine() {
    engine = Engine.create({
      enableSleeping: true
    });

    engine.gravity.y = 1.15;

    rebuildWalls();

    Events.on(engine, "collisionStart", handleCollisions);

    runner = Runner.create();
    Runner.run(runner, engine);
  }

  function createBall(level, x, y, falling = true) {
    const data = LEVELS[level];
    const radius = data.radius * scale;

    const ball = Bodies.circle(x, y, radius, {
      restitution: 0.22,
      friction: 0.42,
      frictionStatic: 0.65,
      frictionAir: 0.012,
      density: 0.0018,
      sleepThreshold: 40,
      label: `ball-${level}`
    });

    ball.gameBall = true;
    ball.level = level;
    ball.spawnedAt = performance.now();
    ball.isFalling = falling;

    Composite.add(engine.world, ball);
    return ball;
  }

  function dropBall() {
    if (!canDrop || gameOver) return;

    canDrop = false;

    const radius = LEVELS[currentLevel].radius * scale;
    const x = clampAim(aimX);
    const y = 54 * scale;

    const ball = createBall(currentLevel, x, y, true);
    Body.setVelocity(ball, { x: 0, y: 1 });

    currentLevel = nextLevel;
    nextLevel = randomNextLevel();
    updateNextPreview();

    setTimeout(() => {
      canDrop = true;
    }, 420);
  }

  function updateNextPreview() {
    nextBallEl.src = `images/ball${nextLevel + 1}.png`;
    nextBallEl.alt = `Next character, level ${nextLevel + 1}`;
  }

  function addScore(points) {
    score += points;
    scoreEl.textContent = String(score);
  }

  function checkNearbyMerges() {
    if (mergeLock || gameOver) return;

    const balls = Composite.allBodies(engine.world)
      .filter(body => body.gameBall && !body.merging);

    for (let i = 0; i < balls.length; i++) {
      for (let j = i + 1; j < balls.length; j++) {
        const a = balls[i];
        const b = balls[j];

        if (a.level !== b.level) continue;
        if (a.level >= LEVELS.length - 1) continue;
        if (a.merging || b.merging) continue;

        const dx = a.position.x - b.position.x;
        const dy = a.position.y - b.position.y;
        const distance = Math.hypot(dx, dy);

        const ra = LEVELS[a.level].radius * scale;
        const rb = LEVELS[b.level].radius * scale;

        // Slight overlap tolerance makes merging feel more forgiving.
        if (distance <= (ra + rb) * 1.06) {
          a.merging = true;
          b.merging = true;
          mergeLock = true;
          mergeBalls(a, b);
          return;
        }
      }
    }
  }

  function handleCollisions(event) {
    if (mergeLock || gameOver) return;

    for (const pair of event.pairs) {
      const a = pair.bodyA;
      const b = pair.bodyB;

      if (!a.gameBall || !b.gameBall) continue;
      if (a.level !== b.level) continue;
      if (a.level >= LEVELS.length - 1) continue;
      if (a.merging || b.merging) continue;

      // Prevent a newly created merge from immediately being reused
      // in the same collision batch.
      a.merging = true;
      b.merging = true;
      mergeLock = true;

      mergeBalls(a, b);
      break;
    }
  }

  function mergeBalls(a, b) {
    const level = a.level;
    const x = (a.position.x + b.position.x) / 2;
    const y = (a.position.y + b.position.y) / 2;

    const vx = (a.velocity.x + b.velocity.x) * 0.2;
    const vy = (a.velocity.y + b.velocity.y) * 0.2;

    Composite.remove(engine.world, [a, b]);

    const merged = createBall(level + 1, x, y, false);
    Body.setVelocity(merged, { x: vx, y: vy });

    addScore(LEVELS[level + 1].points);

    setTimeout(() => {
      mergeLock = false;
    }, 40);
  }

  function pointerPosition(event) {
    const rect = canvas.getBoundingClientRect();
    const clientX = event.clientX;
    return clientX - rect.left;
  }

  function updateAim(x) {
    if (gameOver) return;
    aimX = clampAim(x);
  }

  function drawBall(body) {
    const level = body.level;
    const radius = LEVELS[level].radius * scale;
    const image = images[level];

    ctx.save();
    ctx.translate(body.position.x, body.position.y);
    ctx.rotate(body.angle);

    ctx.beginPath();
    ctx.arc(0, 0, radius, 0, Math.PI * 2);
    ctx.clip();

    if (image && image.complete) {
      ctx.drawImage(
        image,
        -radius,
        -radius,
        radius * 2,
        radius * 2
      );
    } else {
      ctx.fillStyle = "#cccccc";
      ctx.fillRect(-radius, -radius, radius * 2, radius * 2);
    }

    ctx.restore();
  }

  function drawAim() {
    if (!canDrop || gameOver) return;

    const radius = LEVELS[currentLevel].radius * scale;
    const x = clampAim(aimX);
    const y = 54 * scale;
    const image = images[currentLevel];

    ctx.save();

    // Aim guide.
    ctx.strokeStyle = "#111111";
    ctx.lineWidth = 1;
    ctx.setLineDash([5, 5]);

    ctx.beginPath();
    ctx.moveTo(x, y + radius);
    ctx.lineTo(x, groundY);
    ctx.stroke();

    ctx.setLineDash([]);

    // Show the currently selected ball while aiming.
    if (image && image.complete) {
      ctx.globalAlpha = 0.9;
      ctx.save();
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.clip();
      ctx.drawImage(
        image,
        x - radius,
        y - radius,
        radius * 2,
        radius * 2
      );
      ctx.restore();
    } else {
      ctx.globalAlpha = 0.7;
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.restore();
  }

  function drawDangerLine() {
    ctx.save();
    ctx.strokeStyle = "#111111";
    ctx.lineWidth = 1;
    ctx.setLineDash([7, 5]);

    ctx.beginPath();
    ctx.moveTo(0, dangerY);
    ctx.lineTo(width, dangerY);
    ctx.stroke();

    ctx.restore();
  }

  function draw() {
    ctx.clearRect(0, 0, width, height);

    drawDangerLine();

    const bodies = Composite.allBodies(engine.world)
      .filter(body => body.gameBall);

    for (const body of bodies) {
      drawBall(body);
    }

    drawAim();

    requestAnimationFrame(draw);
  }

  function checkGameOver() {
    if (gameOver) return;

    const now = performance.now();
    const balls = Composite.allBodies(engine.world)
      .filter(body => body.gameBall);

    let dangerous = false;

    for (const ball of balls) {
      const radius = LEVELS[ball.level].radius * scale;
      const top = ball.position.y - radius;

      if (
        top < dangerY &&
        now - ball.spawnedAt > 900 &&
        Math.abs(ball.velocity.y) < 0.7
      ) {
        dangerous = true;
        break;
      }
    }

    if (dangerous) {
      if (dangerStarted === null) dangerStarted = now;
      if (now - dangerStarted > 1200) endGame();
    } else {
      dangerStarted = null;
    }
  }

  function endGame() {
    gameOver = true;
    finalScoreEl.textContent = String(score);
    gameOverEl.hidden = false;
  }

  function resetGame() {
    if (!engine) return;

    Composite.clear(engine.world, false);
    rebuildWalls();

    score = 0;
    scoreEl.textContent = "0";
    gameOver = false;
    dangerStarted = null;
    canDrop = true;
    mergeLock = false;
    currentLevel = randomNextLevel();
    nextLevel = randomNextLevel();
    aimX = width / 2;

    updateNextPreview();
    gameOverEl.hidden = true;
  }

  const images = [];
  for (let i = 0; i < 8; i++) {
    const image = new Image();
    image.src = `images/ball${i + 1}.png`;
    images.push(image);
  }

  canvas.addEventListener("pointermove", event => {
    updateAim(pointerPosition(event));
  });

  canvas.addEventListener("pointerdown", event => {
    event.preventDefault();
    updateAim(pointerPosition(event));

    if (event.pointerType === "mouse" || event.pointerType === "touch" || event.pointerType === "pen") {
      dropBall();
    }
  });

  canvas.addEventListener("touchstart", event => {
    event.preventDefault();
  }, { passive: false });

  restartButton.addEventListener("click", resetGame);
  restartTop.addEventListener("click", resetGame);

  window.addEventListener("resize", () => {
    resizeCanvas();
  });

  resizeObserver = new ResizeObserver(resizeCanvas);
  resizeObserver.observe(container);

  setupEngine();
  resizeCanvas();
  currentLevel = randomNextLevel();
  nextLevel = randomNextLevel();
  aimX = width / 2;
  updateNextPreview();

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function loopChecks() {
    checkNearbyMerges();
    checkGameOver();
    setTimeout(loopChecks, 50);
  }

  loopChecks();
  requestAnimationFrame(draw);
})();
