let BaseStrategy = require('./basestrategy').BaseStrategy;

const EL_STATE = {
    waiting: 0,
    moving: 1,
    opening: 2,
    filling: 3,
    closing: 4
};
const PAS_STATE = {
    waitingForElevator: 1,
    movingToElevator: 2,
    returning: 3,
    movingToFloor: 4,
    usingElevator: 5,
    exiting: 6
};
const PAS_HORIZONTAL_SPEED = 2;
const CLOSE_DOORS_TICKS = 100;
const OPEN_DOORS_TICKS = 100;
const EMPTY_ONE_FLOOR_TICKS = 50;
const TAKE_ENEMY_PASS_DELAY_TICKS = 40;
const STOP_TICKS_AFTER_OPEN_DOORS = 40;
const GAME_LEN = 7200;

const MAX_PLAN_LENGTH = 4;
const LOGS = false;
const AICUP_LOGS = true;

let curTick = 0;
let that;

class Strategy extends BaseStrategy {

    //takes original objects from server
    //prepare them and use that data to find best plan
    generatePlan(elevator, allPassengers) {

        let bestPlan = new Plan();

        const emulateAction = (action, elevator, passengers, curPlan) => {
            const tickAfterAction = curTick + curPlan.ticks + action.ticks;
            if (tickAfterAction <= GAME_LEN) { //add break on max plan ticks?
                const {newElev, newPass} = emulate(elevator, passengers, action);
                _generatePlan(newElev, newPass, curPlan.addAction(action, elevator));
            }
        };

        //new plan is better if it's score larger or, if scores equals, if it's ticks less
        const setAsBestIfBetter = (plan) => {
            const planScore = plan.score - plan.floorPenalty;
            const bestPlanScore = bestPlan.score - bestPlan.floorPenalty;
            if (planScore > bestPlanScore ||
                (planScore === bestPlanScore && plan.ticks < bestPlan.ticks)) {
                bestPlan = plan;
                log(`${new Elevator(elevator).toJSON()} new plan: ${dropQuotes(JSON.stringify(plan))}`);
            }
        };

        //takes original elevator and prepared passengers
        const _generatePlan = (elevator, passengers, curPlan = new Plan()) => {
            if (curPlan.actions.length === MAX_PLAN_LENGTH) {
                setAsBestIfBetter(curPlan);
            } else {
                const curPassengersAmount = elevator.passengers.length;
                // let canBuildPlanFurther = false;
                //1. if there is someone on the floor, try to fill elevator with different amounts of passengers
                //no need to try to wait passengers after waiting in prev action
                if (passengers[elevator.floor].length &&
                    (curPlan.isEmpty() || curPlan.lastAction() instanceof GoAction)) {
                    [20]
                        .map(n => n - curPassengersAmount) //how much is needed
                        .filter(n => n > 0)
                        .map(n => passengers[elevator.floor].slice(0, n)) //take first (best) n passengers
                        .filter(distinct) //same passenger arrays will produce same plan points so ignore them
                        .forEach(passengersToWait => {
                            // canBuildPlanFurther = true;
                            const waitAction = new WaitAction(elevator, passengersToWait);
                            emulateAction(waitAction, elevator, passengers, curPlan);
                        });
                }
                //2. anyway, try to go to some floor, floors with max destinations check first
                [1, 2, 3, 4, 5, 6, 7, 8, 9]
                    .map(i => elevator.passengers.filter(p => p.destFloor === i))
                    .map((p, i) => {
                        p.floor = i + 1; //set dest floor to passengers array
                        return p;
                    })
                    .sort((p1, p2) => p2.length - p1.length)
                    .forEach(passengerz => {
                        //there is somebody in elevator wanting on passengerz.floor
                        if (passengerz.length) {
                            // canBuildPlanFurther = true;
                            const goAction = new GoAction(elevator, passengerz.floor, passengerz);
                            emulateAction(goAction, elevator, passengers, curPlan);
                        //there is no one in elevator wanting on passengerz.floor
                        //then check if someone is staying on that floor
                        } else {
                            const goAction = new GoAction(elevator, passengerz.floor);
                            const goActionTicks = goAction.ticks; //calc one time for that block
                            const passengersWillNotGoStairs = passengers[passengerz.floor].filter(p => {
                                const delay = p.type === elevator.type ? 0 : TAKE_ENEMY_PASS_DELAY_TICKS;
                                const time2come = Math.floor(Math.abs(p.x - elevator.x) / PAS_HORIZONTAL_SPEED) + 1;
                                return p.timeToAway > goActionTicks + delay + time2come + 1;
                            });
                            if (passengerz.floor !== elevator.floor && passengersWillNotGoStairs.length) {
                                // canBuildPlanFurther = true;
                                emulateAction(goAction, elevator, passengers, curPlan);
                            }
                        }
                    });
                // if (!canBuildPlanFurther) {
                    setAsBestIfBetter(curPlan);
                // }
            }
        };

        _generatePlan(elevator, groupPassengersByFloorAndSort(elevator, allPassengers));
        return bestPlan;
    }

    onTick(myPassengers, myElevators, enemyPassengers, enemyElevators) {
        that = this;
        curTick += 1;
        if (curTick === 1)
            console.time("Execution time");
        const allPassengers = myPassengers.map(p => new Passenger(p)).concat(enemyPassengers.map(p => new Passenger(p)));
        dropPlansAboutNotWaitingPassengers(allPassengers);
        addXToElevators(myElevators); //delete this line when x will be added to api
        myElevators.forEach(elevator => {
            if (shouldGeneratePlan(elevator)) {
                //todo optimize:
                //todo probably no need to recalc plan if all ppl elevator was waiting in prev tick are still going to it
                const plan = this.generatePlan(elevator, filterPassengers(elevator, allPassengers));
                if (!plan.isEmpty()) {
                    //have a plan -- execute it
                    plan.actions[0].execute(elevator, myPassengers, enemyPassengers);
                    markPassengersWhichElevatorPlanToWait(plan);
                } else if (elevator.passengers.length) {
                    //no plan in remaining time but have passengers -- lift them as max as can
                    const passengersByDestFloor = groupBy(elevator.passengers, p => p.destFloor);
                    const inTimePassengers = passengersByDestFloor.filter((pArr, destFloor) => {
                        return pArr.length && (curTick + new GoAction(elevator, destFloor).ticks < GAME_LEN);
                    });
                    if (inTimePassengers.length) {
                        let bestFloor = inTimePassengers[0][0].destFloor;
                        let maxScore = new GoAction(elevator, bestFloor, inTimePassengers[0]).score;
                        inTimePassengers.forEach(pArr => {
                            const floor = pArr[0].destFloor;
                            const score = new GoAction(elevator, floor, pArr).score;
                            if (score > maxScore) {
                                bestFloor = floor;
                                maxScore = score;
                            }
                        });
                        log(`${new Elevator(elevator).toJSON()} no plan, lift someone to ${bestFloor} floor for ${maxScore} score`);
                        elevator.goToFloor(bestFloor);
                    }
                } else {
                    //no plan and no passengers -- go to potentially good floor
                    log(`${new Elevator(elevator).toJSON()} no plan, passengers: ${JSON.stringify(groupPassengersByFloorAndSort(elevator, filterPassengers(elevator, allPassengers)))}`);
                    const floor = curTick <= 1400 ? 1 : (curTick <= 6000 ? 5 : 9);
                    elevator.goToFloor(floor);
                }
            }
        });
        if (curTick === GAME_LEN)
            console.timeEnd("Execution time");
    }
}

//Map(passenger -> id of elevator which plans to get this passenger)
const PLANNING_PASSENGERS_IDS = [];
function dropPlansAboutNotWaitingPassengers(allPassengers) {
    allPassengers.forEach(p => {
        if (p.state !== PAS_STATE.waitingForElevator && p.state !== PAS_STATE.movingToElevator) {
            PLANNING_PASSENGERS_IDS[p.id] = undefined;
        }
    });
}

function markPassengersWhichElevatorPlanToWait(plan) {
    const elevator = plan.actions[0].elevator;
    PLANNING_PASSENGERS_IDS.forEach((elevId, i) => {
        if (elevId === elevator.id)
            PLANNING_PASSENGERS_IDS[i] = undefined;
    });
    plan.actions.forEach(action => {
        if (action instanceof WaitAction) {
            action.passengers.forEach(p => {
                PLANNING_PASSENGERS_IDS[p.id] = elevator.id;
            })
        }
    });
}

// Functions without side-effects --------------------------------------------------------------------------------------|

function groupPassengersByFloorAndSort(elevator, allPassengers) {
    const passengersByFloor = groupBy(allPassengers, p => p.floor);
    const curPassengersAmount = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(floor => {
        return elevator.passengers.filter(p => p.destFloor === floor).length;
    });
    //todo probably not only by destFloor but by same direction (top or bottom)
    const score = p => curPassengersAmount[p.destFloor] * 1000 - Math.abs(elevator.x - p.x) - (p.weight * 100);
    passengersByFloor.forEach(passengerz => passengerz.sort((p1, p2) => {
        return score(p2) - score(p1);
    }));
    return passengersByFloor;
}

function groupBy(passengers, fun) {
    const res = [[], [], [], [], [], [], [], [], [], []];
    passengers.forEach(p => res[fun(p)].push(new Passenger(p)));
    return res;
}

function filterPassengers(elevator, allPassengers) {
    return allPassengers.filter(p => {
        const plannedByOtherElevator = PLANNING_PASSENGERS_IDS[p.id] && PLANNING_PASSENGERS_IDS[p.id] !== elevator.id;
        return !plannedByOtherElevator && (
                p.state === PAS_STATE.waitingForElevator ||
                p.state === PAS_STATE.returning ||
                p.state === PAS_STATE.movingToElevator && p.elevator === elevator.id
            );
    });
}

function emulate(elevator, passengers, action) {
    //creating copies of elevator and passengers
    let newElev = new Elevator(elevator);
    newElev.setPassengers(newElev.passengers.map(p => new Passenger(p)));
    let newPass = passengers.map(passengerz => {
        return passengerz
            .map(p => {
                const newP = new Passenger(p);
                newP.decTimeToAway(action.ticks);
                return newP;
            })
            //drop passengers who will go to stairs while action executes
            .filter(p => p.timeToAway > 0);
    });
    if (action instanceof WaitAction) {
        //add new passengers to elevator
        const comingPassengers = action.passengers.map(p => new Passenger(p));
        newElev.setPassengers(newElev.passengers.concat(comingPassengers));
        //remove them from waiting list
        newPass[elevator.floor] = subtract(newPass[elevator.floor], comingPassengers);
    } else if (action instanceof GoAction) {
        //remove passengers from elevator
        newElev.setPassengers(subtract(newElev.passengers, action.passengers));
        newElev.setFloor(action.floor);
        newElev.setTimeOnFloor(OPEN_DOORS_TICKS);
    }
    return {
        newElev,
        newPass
    }
}

function subtract(initial, subtractor) {
    return initial.filter(p => {
        return !subtractor.find(ap => ap.id === p.id);
    })
}

function distinct(passengersToWait, i, arr) {
    return arr.findIndex(pass => pass.length === passengersToWait.length) === i;
}

function shouldGeneratePlan(elevator) {
    return elevator.state === EL_STATE.filling &&
        (elevator.timeOnFloor >= OPEN_DOORS_TICKS + STOP_TICKS_AFTER_OPEN_DOORS - 1 || curTick < 100);
}

// ---------------------------------------------------------------------------------------------------------------------|

class WaitAction {
    constructor(elevator, passengersToWait) {
        this.elevator = elevator;
        this.passengers = passengersToWait;
    }
    get ticks() {
        let maxTime = 0;
        this.passengers.forEach(p => {
            const timeToCome = Math.floor(Math.abs(p.x - this.elevator.x) / PAS_HORIZONTAL_SPEED) + 1;
            const enemyDelay = p.type === this.elevator.type ? 0 : Math.max(0, 40 - this.elevator.timeOnFloor);
            const factTime = timeToCome + enemyDelay;
            maxTime = Math.max(maxTime, factTime);
        });
        return maxTime;
    }
    get score() {
        return 0;
    }
    //MUTATES PASSENGERS!
    execute(elevator, myPassengers, enemyPassengers) {
        this._setElevatorToPassengers(myPassengers);
        this._setElevatorToPassengers(enemyPassengers);
        log(`Elev ${elevator.id} will wait for ${this.passengers.length} passengers`);
    }
    _setElevatorToPassengers(passengers) {
        passengers.forEach(p => {
            if (this.passengers.find(wp => wp.id === p.id)) {
                p.setElevator(this.elevator);
            }
        })
    }
    toJSON() {
        return `WaitAction(pass: ${this.passengers.length}, ticks: ${this.ticks})`;
    }
}

class GoAction {
    constructor(elevator, floor, passengers = []) {
        this.elevator = elevator;
        this.floor = floor;
        this.passengers = passengers;
    }
    get ticks() {
        let movingTicks = 0;
        if (this.passengers.length === 0 || this.floor < this.elevator.floor) {
            movingTicks = Math.abs(this.elevator.floor - this.floor) * EMPTY_ONE_FLOOR_TICKS;
        } else {
            const weightFactor = this.elevator.passengers.reduce((acc, p) => acc * p.weight, 1);
            const overweightFactor = this.elevator.passengers.length > 10 ? 1.1 : 1;
            const oneFloorTicks = EMPTY_ONE_FLOOR_TICKS * weightFactor * overweightFactor;
            movingTicks = Math.abs(this.elevator.floor - this.floor) * oneFloorTicks;
        }
        return Math.floor(CLOSE_DOORS_TICKS + movingTicks + OPEN_DOORS_TICKS) + 1;
    }
    get score() {
        return this.passengers.reduce((acc, p) => {
            return acc + Math.abs(p.fromFloor - p.destFloor) * 10 * (this.elevator.type === p.type ? 1 : 2);
        }, 0);
    }
    //MUTATES ELEVATOR!
    execute(elevator, myPassengers, enemyPassengers) {
        elevator.goToFloor(this.floor);
        log(`Elev ${elevator.id} will go to ${this.floor} to lift ${this.passengers.length} passenger(s)`);
    }
    toJSON() {
        return `GoAction(floor: ${this.floor}, pass: ${this.passengers.length}, ticks: ${this.ticks})`;
    }
}

class Plan {
    constructor() {
        this.actions = [];
        this.ticks = 0;
        this.score = 0;
        this.floorPenalty = 0;
    }
    //creates copy
    addAction(action, elevator) {
        const newPlan = new Plan();
        newPlan.ticks = this.ticks + action.ticks;
        newPlan.score = this.score + action.score;
        if (this.actions.length) {
            //todo penalty for going in area where less my current passengers want to be?
            //penalty for distance which would be passed by lift
            const penalty = this.actions.reduce((acc, a) => {
                return acc + (a.floor && Math.abs(a.floor - elevator.floor) || 0);
            }, 0) * 100;
            newPlan.floorPenalty = this.floorPenalty + penalty;
        }
        newPlan.actions = this.actions.slice();
        newPlan.actions.push(action);
        return newPlan;
    }
    toJSON() {
        return `{ticks: ${this.ticks}, score: ${this.score}, actions: ${JSON.stringify(this.actions)}}`;
    }
    isEmpty() {
        return this.actions.length === 0;
    }
    lastAction() {
        return this.actions[this.actions.length - 1];
    }
}

class Elevator {
    constructor({id, _x, _y, _passengers, _state, _speed, _floor, _nextFloor, _timeOnFloor, _type}) {
        this.id = id;
        this._x = _x;
        this.x = _x;
        this._y = _y;
        this.y = _y;
        this._passengers = _passengers.map(p =>  new Passenger(p));
        this.passengers = this._passengers;
        this._state = _state;
        this.state = _state;
        this._speed = _speed;
        this.speed = _speed;
        this._floor = _floor;
        this.floor = _floor;
        this._nextFloor = _nextFloor;
        this.nextFloor = _nextFloor;
        this._timeOnFloor = _timeOnFloor;
        this.timeOnFloor = _timeOnFloor;
        this._type = _type;
        this.type = _type;
    }

    setPassengers(passengers) {
        this._passengers = passengers;
        this.passengers = passengers;
    }

    setFloor(floor) {
        this._floor = floor;
        this.floor = floor;
    }

    setTimeOnFloor(time) {
        this._timeOnFloor = time;
        this.timeOnFloor = time;
    }

    toJSON() {
        return `Elev(id: ${this.id}, state: ${this.state}, floor: ${this.floor})`;
    }
}

class Passenger {
    constructor({id, _elevator, _x, _y, _state, _timeToAway, _fromFloor, _destFloor, _type, _floor, _weight}) {
        this.id = id;
        this._elevator = _elevator;
        this.elevator = _elevator;
        this._fromFloor = _fromFloor;
        this.fromFloor = _fromFloor;
        this._destFloor = _destFloor;
        this.destFloor = _destFloor;
        this._timeToAway = _timeToAway;
        this.timeToAway = _timeToAway;
        this._state = _state;
        this.state = _state;
        this._floor = _floor;
        this.floor = _floor;
        this._type = _type;
        this.type = _type;
        this._x = _x;
        this.x = _x;
        this._y = _y;
        this.y = _y;
        this._weight = _weight;
        this.weight = _weight;
    }

    decTimeToAway(dt) {
        this._timeToAway -= dt;
        this.timeToAway = this._timeToAway;
    }

    toJSON() {
        return `Pass(state: ${this.state}, floor: ${this.floor}, elev: ${(this.elevator && this.elevator.id) || this.elevator})`;
    }
}

function log(text) {
    if (LOGS)
        console.log(`[tick ${curTick}] ${text}`);
    if (AICUP_LOGS)
        that.debug(text);
}

function dropQuotes(s) {
    return s.replace(/\\\"/g, '');
}

function addXToElevators(elevators) {
    elevators.forEach((elev, i) => {
        const sign = elev.type === 'FIRST_PLAYER' ? -1 : 1;
        elev.x = sign * (60 + 80 * i);
        elev._x = elev.x;
    });
}

module.exports.Strategy = Strategy;
